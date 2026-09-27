import {
  CONTRACT_VERSION,
  assertContract,
  type CanonicalNote,
  type Checkpoint,
  type ExportReceipt,
  type QualityDecision,
  type RawEnvelope,
  type RetryQueueSnapshot,
  type TaskError,
  type TaskSpec,
  type TaskState,
} from "../../contracts/src/index.ts";
import { classifyUnknownError } from "./errors.ts";
import { listSearchCards, normalizeNote } from "./normalizer.ts";
import type {
  Clock,
  EvidenceStore,
  ExportHub,
  IdProvider,
  PlatformCollector,
  RunControl,
  RunControlContext,
  UpsertResult,
} from "./ports.ts";
import { evaluateNote } from "./quality.ts";
import { ContinueRunControl } from "./run-control.ts";
import {
  DEFAULT_RETRY_POLICY,
  beginRetry,
  enqueueRetry,
  failRetry,
  recoverInterruptedRetries,
  resolveRetry,
  type RetryPolicy,
} from "./retry-queue.ts";
import { transitionTask } from "./state-machine.ts";

export interface RunSummary {
  taskId: string;
  finalState: TaskState;
  collectedSearchCards: number;
  attemptedDetails: number;
  notes: CanonicalNote[];
  quality: QualityDecision[];
  failures: TaskError[];
  upsert: UpsertResult;
  receipts: ExportReceipt[];
}

export interface RetryTargetResult {
  taskId: string;
  targetId: string;
  outcome: "RESOLVED" | "REQUEUED" | "EXHAUSTED" | "BLOCKED";
  failure: TaskError | null;
  note: CanonicalNote | null;
  quality: QualityDecision | null;
  upsert: UpsertResult;
  receipts: ExportReceipt[];
  retryQueue: RetryQueueSnapshot;
}

interface RunProgress {
  state: TaskState;
  completedTargets: string[];
  failures: TaskError[];
  collectedSearchCards: number;
  attemptedDetails: number;
  notes: CanonicalNote[];
  quality: QualityDecision[];
  upsert: UpsertResult;
}

export class TaskOrchestrator {
  private readonly collector: PlatformCollector;
  private readonly store: EvidenceStore;
  private readonly exporter: ExportHub;
  private readonly clock: Clock;
  private readonly ids: IdProvider;
  private readonly control: RunControl;
  private readonly retryPolicy: RetryPolicy;

  constructor(input: {
    collector: PlatformCollector;
    store: EvidenceStore;
    exporter: ExportHub;
    clock: Clock;
    ids: IdProvider;
    control?: RunControl;
    retryPolicy?: RetryPolicy;
  }) {
    this.collector = input.collector;
    this.store = input.store;
    this.exporter = input.exporter;
    this.clock = input.clock;
    this.ids = input.ids;
    this.control = input.control ?? new ContinueRunControl();
    this.retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  private checkpoint(taskId: string, progress: Pick<RunProgress, "state" | "completedTargets" | "failures">): Checkpoint {
    const checkpoint: Checkpoint = {
      schemaVersion: CONTRACT_VERSION,
      taskId,
      state: progress.state,
      completedTargets: [...progress.completedTargets],
      failedTargets: [...progress.failures],
      updatedAt: this.clock.now(),
    };
    assertContract<Checkpoint>("Checkpoint", checkpoint);
    return checkpoint;
  }

  private assertTask(task: TaskSpec): void {
    assertContract<TaskSpec>("TaskSpec", task);
    if (task.authorization.externalApi || task.authorization.upload || task.authorization.publish) {
      throw new Error("The local slice only accepts tasks with externalApi/upload/publish disabled.");
    }
  }

  private async saveCheckpoint(taskId: string, progress: RunProgress): Promise<void> {
    await this.store.saveCheckpoint(this.checkpoint(taskId, progress));
  }

  private async queueFailure(taskId: string, failure: TaskError): Promise<void> {
    if (failure.category !== "RETRYABLE" || !failure.retryable) return;
    const queue = enqueueRetry(
      await this.store.getRetryQueue(taskId),
      taskId,
      failure,
      this.retryPolicy,
      this.clock.now(),
    );
    await this.store.saveRetryQueue(queue);
  }

  private async exportCurrent(task: TaskSpec): Promise<ExportReceipt[]> {
    const allNotes = await this.store.listNotes();
    const allQuality = await this.store.listQuality();
    const qualityById = new Map(allQuality.map((decision) => [decision.entityId, decision]));
    const rows = allNotes
      .filter((note) => qualityById.has(note.noteId))
      .map((note) => ({ note, quality: qualityById.get(note.noteId)! }));
    return this.exporter.exportRows(task, rows);
  }

  private async applyControl(
    taskId: string,
    stage: RunControlContext["stage"],
    targetId: string,
    progress: RunProgress,
  ): Promise<boolean> {
    const decision = await this.control.decide({
      taskId,
      stage,
      targetId,
      completedTargets: [...progress.completedTargets],
      failedTargets: [...progress.failures],
    });
    if (decision === "CONTINUE") return true;
    progress.state = transitionTask(progress.state, decision === "PAUSE" ? "PAUSE" : "CANCEL");
    await this.saveCheckpoint(taskId, progress);
    return false;
  }

  private async summary(taskId: string, progress: RunProgress, receipts: ExportReceipt[] = []): Promise<RunSummary> {
    if (progress.upsert.total === 0) {
      progress.upsert.total = (await this.store.listNotes()).length;
    }
    return {
      taskId,
      finalState: progress.state,
      collectedSearchCards: progress.collectedSearchCards,
      attemptedDetails: progress.attemptedDetails,
      notes: progress.notes,
      quality: progress.quality,
      failures: progress.failures,
      upsert: progress.upsert,
      receipts,
    };
  }

  private async execute(task: TaskSpec, progress: RunProgress): Promise<RunSummary> {
    if (!await this.applyControl(task.taskId, "BEFORE_SEARCH", task.seedKeywords[0], progress)) {
      return this.summary(task.taskId, progress);
    }

    const keyword = task.seedKeywords[0];
    const searchEnvelope: RawEnvelope = await this.collector.collectSearch(keyword, task.limits.maxSearchResults);
    assertContract<RawEnvelope>("RawEnvelope", searchEnvelope);
    const cards = listSearchCards(searchEnvelope).slice(0, task.limits.maxSearchResults);
    const selectedCards = cards.slice(0, task.limits.maxNoteDetails);
    progress.collectedSearchCards = cards.length;

    for (const card of selectedCards) {
      if (progress.completedTargets.includes(card.noteId)) continue;
      if (!await this.applyControl(task.taskId, "BEFORE_DETAIL", card.noteId, progress)) {
        return this.summary(task.taskId, progress);
      }
      progress.attemptedDetails += 1;
      try {
        const detailEnvelope = await this.collector.collectNote(card.noteId);
        assertContract<RawEnvelope>("RawEnvelope", detailEnvelope);
        const note = normalizeNote({ keyword, card, searchEnvelope, detailEnvelope });
        assertContract<CanonicalNote>("CanonicalNote", note);
        const decision = evaluateNote(note, this.clock.now());
        assertContract<QualityDecision>("QualityDecision", decision);

        const write = await this.store.upsertNotes([note]);
        await this.store.saveQuality([decision]);
        progress.upsert.inserted += write.inserted;
        progress.upsert.updated += write.updated;
        progress.upsert.total = write.total;
        progress.notes.push(note);
        progress.quality.push(decision);
        progress.completedTargets.push(card.noteId);
        progress.failures = progress.failures.filter((failure) => failure.targetId !== card.noteId);
      } catch (error) {
        const failure = classifyUnknownError(error, card.noteId);
        progress.failures = [
          ...progress.failures.filter((item) => item.targetId !== failure.targetId),
          failure,
        ];
        await this.queueFailure(task.taskId, failure);
        if (failure.category === "NEEDS_HUMAN") {
          progress.state = transitionTask(progress.state, "REQUIRE_HUMAN");
          await this.saveCheckpoint(task.taskId, progress);
          return this.summary(task.taskId, progress);
        }
      }
      await this.saveCheckpoint(task.taskId, progress);
    }

    if (!await this.applyControl(task.taskId, "BEFORE_EXPORT", task.taskId, progress)) {
      return this.summary(task.taskId, progress);
    }
    const receipts = await this.exportCurrent(task);

    progress.state = transitionTask(progress.state, "COMPLETE");
    await this.saveCheckpoint(task.taskId, progress);
    return this.summary(task.taskId, progress, receipts);
  }

  async run(task: TaskSpec): Promise<RunSummary> {
    this.assertTask(task);
    const progress: RunProgress = {
      state: "DRAFT",
      completedTargets: [],
      failures: [],
      collectedSearchCards: 0,
      attemptedDetails: 0,
      notes: [],
      quality: [],
      upsert: { inserted: 0, updated: 0, total: 0 },
    };
    progress.state = transitionTask(progress.state, "CONFIGURE");
    await this.saveCheckpoint(task.taskId, progress);
    progress.state = transitionTask(progress.state, "START");
    await this.saveCheckpoint(task.taskId, progress);
    return this.execute(task, progress);
  }

  async resume(task: TaskSpec): Promise<RunSummary> {
    this.assertTask(task);
    const checkpoint = await this.store.getCheckpoint(task.taskId);
    if (!checkpoint) throw new Error(`No checkpoint exists for task: ${task.taskId}`);
    if (checkpoint.state !== "PAUSED" && checkpoint.state !== "NEEDS_HUMAN") {
      throw new Error(`Task ${task.taskId} cannot resume from ${checkpoint.state}.`);
    }
    const progress: RunProgress = {
      state: transitionTask(checkpoint.state, checkpoint.state === "PAUSED" ? "RESUME" : "RESOLVE_HUMAN"),
      completedTargets: [...checkpoint.completedTargets],
      failures: [...checkpoint.failedTargets],
      collectedSearchCards: 0,
      attemptedDetails: 0,
      notes: [],
      quality: [],
      upsert: { inserted: 0, updated: 0, total: (await this.store.listNotes()).length },
    };
    await this.saveCheckpoint(task.taskId, progress);
    return this.execute(task, progress);
  }

  async retryTarget(task: TaskSpec, targetId: string): Promise<RetryTargetResult> {
    this.assertTask(task);
    let queue = await this.store.getRetryQueue(task.taskId);
    if (!queue) throw new Error(`No retry queue exists for task: ${task.taskId}`);
    queue = recoverInterruptedRetries(queue, this.retryPolicy, this.clock.now());
    queue = beginRetry(queue, targetId, this.clock.now());
    await this.store.saveRetryQueue(queue);

    try {
      const keyword = task.seedKeywords[0];
      const searchEnvelope = await this.collector.collectSearch(keyword, task.limits.maxSearchResults);
      assertContract<RawEnvelope>("RawEnvelope", searchEnvelope);
      const card = listSearchCards(searchEnvelope).find((candidate) => candidate.noteId === targetId);
      if (!card) {
        throw new Error(`Retry target ${targetId} is not present in the current search evidence.`);
      }
      const detailEnvelope = await this.collector.collectNote(targetId);
      assertContract<RawEnvelope>("RawEnvelope", detailEnvelope);
      const note = normalizeNote({ keyword, card, searchEnvelope, detailEnvelope });
      assertContract<CanonicalNote>("CanonicalNote", note);
      const quality = evaluateNote(note, this.clock.now());
      assertContract<QualityDecision>("QualityDecision", quality);
      const upsert = await this.store.upsertNotes([note]);
      await this.store.saveQuality([quality]);

      queue = resolveRetry(queue, targetId, this.clock.now());
      await this.store.saveRetryQueue(queue);
      const checkpoint = await this.store.getCheckpoint(task.taskId);
      if (checkpoint) {
        checkpoint.completedTargets = [...new Set([...checkpoint.completedTargets, targetId])];
        checkpoint.failedTargets = checkpoint.failedTargets.filter((failure) => failure.targetId !== targetId);
        checkpoint.updatedAt = this.clock.now();
        await this.store.saveCheckpoint(checkpoint);
      }
      const receipts = await this.exportCurrent(task);
      return {
        taskId: task.taskId,
        targetId,
        outcome: "RESOLVED",
        failure: null,
        note,
        quality,
        upsert,
        receipts,
        retryQueue: queue,
      };
    } catch (error) {
      const failure = classifyUnknownError(error, targetId);
      queue = failRetry(queue, targetId, failure, this.retryPolicy, this.clock.now());
      await this.store.saveRetryQueue(queue);
      const checkpoint = await this.store.getCheckpoint(task.taskId);
      if (checkpoint) {
        checkpoint.failedTargets = [
          ...checkpoint.failedTargets.filter((item) => item.targetId !== targetId),
          failure,
        ];
        checkpoint.updatedAt = this.clock.now();
        await this.store.saveCheckpoint(checkpoint);
      }
      const item = queue.items.find((candidate) => candidate.targetId === targetId)!;
      return {
        taskId: task.taskId,
        targetId,
        outcome: item.state === "QUEUED" ? "REQUEUED" : item.state as "EXHAUSTED" | "BLOCKED",
        failure,
        note: null,
        quality: null,
        upsert: { inserted: 0, updated: 0, total: (await this.store.listNotes()).length },
        receipts: [],
        retryQueue: queue,
      };
    }
  }
}
