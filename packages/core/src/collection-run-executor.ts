import {
  assertContract,
  type CollectionRunLedger,
  type CollectionRunStatus,
  type NoteCompletenessLedger,
  type RawEnvelope,
  type TaskError,
} from "../../contracts/src/index.ts";
import { classifyUnknownError, WorkbenchError } from "./errors.ts";
import { CollectionRunWorkbench } from "./collection-run-workbench.ts";
import type { NoteCompletenessObservation, ObservationAccessState } from "./completeness-ledger.ts";
import type {
  Clock,
  CollectionTargetCollector,
  CollectionTargetResult,
  CommentsCollectionObservation,
  DetailCollectionObservation,
  EvidenceStore,
} from "./ports.ts";
import { evaluateNote } from "./quality.ts";
import { RankingWorkbench } from "./ranking-workbench.ts";

export interface CollectionFailureRoute {
  targetId: string;
  category: TaskError["category"];
  code: string;
  outcome: "RETRIED" | "BLOCKED" | "FAILED";
  attempt: number;
}

export interface CollectionExecutionReceipt {
  runId: string;
  status: CollectionRunStatus;
  dispatched: number;
  completed: number;
  retried: number;
  blocked: number;
  failed: number;
  normalizedNotes: number;
  evidenceEnvelopeIds: string[];
  failureRoutes: CollectionFailureRoute[];
  startedAt: string;
  finishedAt: string;
}

function accessFromStatus(status: NoteCompletenessLedger["detail"]["status"]): ObservationAccessState {
  if (status === "INACCESSIBLE" || status === "DRIFTED" || status === "HUMAN_REQUIRED") return status;
  return "VISIBLE";
}

function detailObservation(
  current: NoteCompletenessLedger | null,
  incoming?: DetailCollectionObservation,
): NoteCompletenessObservation["detail"] {
  if (incoming) return {
    access: incoming.access,
    requiredFields: incoming.requiredFields,
    presentFields: incoming.presentFields,
    evidenceEnvelopeIds: incoming.evidenceEnvelopeIds,
  };
  if (current) return {
    access: accessFromStatus(current.detail.status),
    requiredFields: current.detail.requiredFields,
    presentFields: current.detail.presentFields,
    evidenceEnvelopeIds: current.detail.evidenceEnvelopeIds,
  };
  return {
    access: "VISIBLE",
    requiredFields: ["title", "body", "author", "metrics", "assets"],
    presentFields: [],
    evidenceEnvelopeIds: [],
  };
}

function commentsObservation(
  current: NoteCompletenessLedger | null,
  incoming?: CommentsCollectionObservation,
): NoteCompletenessObservation["comments"] {
  if (incoming) return {
    access: incoming.access,
    platformDeclaredTotal: incoming.platformDeclaredTotal,
    capturedTopLevelIds: incoming.capturedTopLevelIds,
    replyThreads: incoming.replyThreads,
    topLevelPaginationExhausted: incoming.topLevelPaginationExhausted,
    nextCursor: incoming.nextCursor,
    evidenceEnvelopeIds: incoming.evidenceEnvelopeIds,
  };
  if (current) return {
    access: accessFromStatus(current.comments.status),
    platformDeclaredTotal: current.comments.platformDeclaredTotal,
    capturedTopLevelIds: current.comments.capturedTopLevelIds,
    replyThreads: current.comments.replyThreads.map((thread) => ({
      parentCommentId: thread.parentCommentId,
      declaredReplyCount: thread.declaredReplyCount,
      capturedReplyIds: thread.capturedReplyIds,
      expansionExhausted: thread.expansionExhausted,
    })),
    topLevelPaginationExhausted: current.comments.topLevelPaginationExhausted,
    nextCursor: current.comments.nextCursor,
    evidenceEnvelopeIds: current.comments.evidenceEnvelopeIds,
  };
  return {
    access: "VISIBLE",
    platformDeclaredTotal: null,
    capturedTopLevelIds: [],
    replyThreads: [],
    topLevelPaginationExhausted: false,
    nextCursor: null,
    evidenceEnvelopeIds: [],
  };
}

function observationTime(result: CollectionTargetResult): string | null {
  const times = [result.detailObservation?.observedAt, result.commentsObservation?.observedAt].filter(Boolean) as string[];
  if (times.length === 0) return null;
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export class CollectionRunExecutor {
  private readonly collector: CollectionTargetCollector;
  private readonly store: EvidenceStore;
  private readonly clock: Clock;
  private readonly runs: CollectionRunWorkbench;
  private readonly ranking: RankingWorkbench;
  private readonly maxAttemptsPerTarget: number;
  private readonly maxDispatches: number;

  constructor(input: {
    collector: CollectionTargetCollector;
    store: EvidenceStore;
    clock: Clock;
    maxAttemptsPerTarget?: number;
    maxDispatches?: number;
  }) {
    this.collector = input.collector;
    this.store = input.store;
    this.clock = input.clock;
    this.runs = new CollectionRunWorkbench(input.store);
    this.ranking = new RankingWorkbench(input.store);
    this.maxAttemptsPerTarget = input.maxAttemptsPerTarget ?? 3;
    this.maxDispatches = input.maxDispatches ?? 10_000;
    if (!Number.isInteger(this.maxAttemptsPerTarget) || this.maxAttemptsPerTarget < 1) {
      throw new Error("maxAttemptsPerTarget must be a positive integer.");
    }
  }

  private async persistResult(result: CollectionTargetResult): Promise<string[]> {
    if (!Array.isArray(result.envelopes) || result.envelopes.length === 0) {
      throw new WorkbenchError({
        category: "PERMANENT",
        code: "COLLECTION_RESULT_WITHOUT_EVIDENCE",
        message: "A collector result must contain at least one raw evidence envelope.",
        targetId: "collection-result",
        retryable: false,
      });
    }
    for (const envelope of result.envelopes) assertContract<RawEnvelope>("RawEnvelope", envelope);
    await this.store.saveRawEnvelopes(result.envelopes);

    if (result.rankingSnapshot) await this.ranking.recordRankingSnapshot(result.rankingSnapshot);

    const noteId = result.detailObservation?.noteId ?? result.commentsObservation?.noteId ?? null;
    const observedAt = observationTime(result);
    if (noteId && observedAt) {
      if (result.detailObservation && result.commentsObservation
        && result.detailObservation.noteId !== result.commentsObservation.noteId) {
        throw new Error("Detail and comment observations must belong to the same note.");
      }
      const current = await this.store.getCompletenessLedger(noteId);
      await this.ranking.recordCompleteness({
        noteId,
        observedAt,
        detail: detailObservation(current, result.detailObservation),
        comments: commentsObservation(current, result.commentsObservation),
      });
    }

    if (result.canonicalNotes?.length) {
      for (const note of result.canonicalNotes) assertContract("CanonicalNote", note);
      await this.store.upsertNotes(result.canonicalNotes);
      await this.store.saveQuality(result.canonicalNotes.map((note) => evaluateNote(note, this.clock.now())));
    }
    return [...new Set(result.envelopes.map((envelope) => envelope.envelopeId))];
  }

  private async requireTargetCompleteness(target: CollectionRunLedger["targets"][number]): Promise<void> {
    if (target.stage !== "DETAIL" && target.stage !== "COMMENTS") return;
    if (!target.noteId) {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_COMPLETENESS_NOTE_ID_REQUIRED",
        message: `${target.stage} target cannot be closed without a note ID.`,
        targetId: target.targetId,
        retryable: false,
      });
    }
    const ledger = await this.store.getCompletenessLedger(target.noteId);
    const status = target.stage === "DETAIL" ? ledger?.detail.status : ledger?.comments.status;
    if (status === "COMPLETE") return;
    if (status === "INACCESSIBLE" || status === "DRIFTED" || status === "HUMAN_REQUIRED") {
      throw new WorkbenchError({
        category: "NEEDS_HUMAN",
        code: `${target.stage}_COMPLETENESS_${status}`,
        message: `${target.stage} evidence is ${status}; the target remains open and requires human handling.`,
        targetId: target.targetId,
        retryable: false,
      });
    }
    throw new WorkbenchError({
      category: "RETRYABLE",
      code: `${target.stage}_COMPLETENESS_${status ?? "NOT_OBSERVED"}`,
      message: `${target.stage} evidence is not complete; keep the evidence and schedule gap collection.`,
      targetId: target.targetId,
      retryable: true,
    });
  }

  async execute(runId: string): Promise<CollectionExecutionReceipt> {
    const startedAt = this.clock.now();
    await this.runs.recover(runId, startedAt);
    let dispatched = 0;
    let completed = 0;
    let retried = 0;
    let blocked = 0;
    let failed = 0;
    let normalizedNotes = 0;
    const evidenceEnvelopeIds: string[] = [];
    const failureRoutes: CollectionFailureRoute[] = [];

    while (dispatched < this.maxDispatches) {
      const current = await this.runs.get(runId);
      if (["PAUSED", "COMPLETED", "COMPLETED_WITH_BLOCKS", "FAILED", "CANCELLED"].includes(current.status)) break;
      const target = await this.runs.claim(runId, this.clock.now());
      if (!target) break;
      dispatched += 1;
      let committedEvidence: string[] = [];
      try {
        const result = await this.collector.collectTarget(target);
        const evidence = await this.persistResult(result);
        committedEvidence = evidence;
        normalizedNotes += result.canonicalNotes?.length ?? 0;
        evidenceEnvelopeIds.push(...evidence);
        await this.requireTargetCompleteness(target);
        await this.runs.complete(runId, target.targetId, evidence, this.clock.now());
        completed += 1;
      } catch (error) {
        const routed = classifyUnknownError(error, target.targetId);
        if (routed.category === "RETRYABLE" && routed.retryable && target.attempts < this.maxAttemptsPerTarget) {
          await this.runs.retry(runId, target.targetId, routed, this.clock.now(), committedEvidence);
          retried += 1;
          failureRoutes.push({ targetId: target.targetId, category: routed.category, code: routed.code, outcome: "RETRIED", attempt: target.attempts });
        } else if (routed.category === "NEEDS_HUMAN" || routed.category === "POLICY_BLOCKED") {
          await this.runs.block(runId, target.targetId, routed, this.clock.now(), committedEvidence);
          blocked += 1;
          failureRoutes.push({ targetId: target.targetId, category: routed.category, code: routed.code, outcome: "BLOCKED", attempt: target.attempts });
        } else {
          await this.runs.fail(runId, target.targetId, routed, this.clock.now(), committedEvidence);
          failed += 1;
          failureRoutes.push({ targetId: target.targetId, category: routed.category, code: routed.code, outcome: "FAILED", attempt: target.attempts });
        }
      }
    }

    const ledger: CollectionRunLedger = await this.runs.get(runId);
    return {
      runId,
      status: ledger.status,
      dispatched,
      completed,
      retried,
      blocked,
      failed,
      normalizedNotes,
      evidenceEnvelopeIds: [...new Set(evidenceEnvelopeIds)].sort(),
      failureRoutes,
      startedAt,
      finishedAt: this.clock.now(),
    };
  }
}
