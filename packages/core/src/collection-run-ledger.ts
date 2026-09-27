import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContract,
  type CollectionRunBudget,
  type CollectionRunLedger,
  type CollectionRunStatus,
  type CollectionRunTarget,
  type CollectionStage,
  type EnrichmentPlan,
  type KeywordPlan,
  type TaskError,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "./errors.ts";

export interface CollectionRunInput {
  runId: string;
  keywordPlan: KeywordPlan;
  enrichmentPlan: EnrichmentPlan;
  rankingScopeIds: string[];
  budget: CollectionRunBudget;
  createdAt: string;
}

export interface CollectionStageProgress {
  total: number;
  eligible: number;
  attempted: number;
  queued: number;
  inProgress: number;
  completed: number;
  blocked: number;
  failed: number;
  skipped: number;
}

export type CollectionRunProgress = Record<CollectionStage, CollectionStageProgress>;

const stageOrder: Record<CollectionStage, number> = {
  RANKING_SNAPSHOT: 0,
  DETAIL: 1,
  COMMENTS: 2,
  KEYWORD_SEARCH: 3,
};

function targetId(stage: CollectionStage, identity: string): string {
  const digest = createHash("sha256").update(`${stage}:${identity}`, "utf8").digest("hex").slice(0, 16);
  return `collect-${stage.toLocaleLowerCase().replaceAll("_", "-")}-${digest}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function target(input: {
  stage: CollectionStage;
  identity: string;
  state: CollectionRunTarget["state"];
  priority: number;
  keywordId?: string;
  query?: string;
  scopeId?: string;
  noteId?: string;
  error?: TaskError;
  reason?: string;
  now: string;
}): CollectionRunTarget {
  const id = targetId(input.stage, input.identity);
  return {
    targetId: id,
    stage: input.stage,
    state: input.state,
    priority: input.priority,
    keywordId: input.keywordId ?? null,
    query: input.query ?? null,
    scopeId: input.scopeId ?? null,
    noteId: input.noteId ?? null,
    attempts: 0,
    evidenceEnvelopeIds: [],
    lastError: input.error ? { ...input.error, targetId: id } : null,
    errorHistory: input.error ? [{ ...input.error, targetId: id }] : [],
    dispositionReason: input.reason ?? null,
    updatedAt: input.now,
  };
}

function skippedByBudget(
  stage: CollectionStage,
  identity: string,
  priority: number,
  references: Pick<CollectionRunTarget, "keywordId" | "query" | "scopeId" | "noteId">,
  now: string,
): CollectionRunTarget {
  return target({
    stage,
    identity,
    state: "SKIPPED",
    priority,
    keywordId: references.keywordId ?? undefined,
    query: references.query ?? undefined,
    scopeId: references.scopeId ?? undefined,
    noteId: references.noteId ?? undefined,
    reason: "BUDGET_LIMIT",
    now,
  });
}

function blockedStage(reason: string): CollectionStage[] {
  if (reason.startsWith("DETAIL_")) return ["DETAIL"];
  if (reason.startsWith("COMMENTS_")) return ["COMMENTS"];
  return ["DETAIL", "COMMENTS"];
}

function sortTargets(targets: CollectionRunTarget[]): CollectionRunTarget[] {
  return targets.sort((a, b) => b.priority - a.priority
    || stageOrder[a.stage] - stageOrder[b.stage]
    || a.targetId.localeCompare(b.targetId));
}

export function createCollectionRunLedger(input: CollectionRunInput): CollectionRunLedger {
  assertContract<KeywordPlan>("KeywordPlan", input.keywordPlan);
  assertContract<EnrichmentPlan>("EnrichmentPlan", input.enrichmentPlan);
  const targets: CollectionRunTarget[] = [];
  const rankingScopeIds = unique(input.rankingScopeIds);

  rankingScopeIds.forEach((scopeId, index) => {
    const references = { keywordId: null, query: null, scopeId, noteId: null };
    targets.push(index < input.budget.maxRankingSnapshots
      ? target({ stage: "RANKING_SNAPSHOT", identity: scopeId, state: "QUEUED", priority: 100, scopeId, now: input.createdAt })
      : skippedByBudget("RANKING_SNAPSHOT", scopeId, 100, references, input.createdAt));
  });

  input.keywordPlan.nodes.forEach((node, index) => {
    const priority = Math.max(1, 60 - node.depth);
    const references = { keywordId: node.keywordId, query: node.value, scopeId: null, noteId: null };
    targets.push(index < input.budget.maxKeywordSearches
      ? target({
          stage: "KEYWORD_SEARCH",
          identity: node.keywordId,
          state: "QUEUED",
          priority,
          keywordId: node.keywordId,
          query: node.value,
          now: input.createdAt,
        })
      : skippedByBudget("KEYWORD_SEARCH", node.keywordId, priority, references, input.createdAt));
  });

  let detailCount = 0;
  let commentCount = 0;
  for (const enrichment of input.enrichmentPlan.tasks) {
    for (const stage of enrichment.stages) {
      const current = stage === "DETAIL" ? detailCount : commentCount;
      const maximum = stage === "DETAIL" ? input.budget.maxDetailTargets : input.budget.maxCommentTargets;
      const references = { keywordId: null, query: null, scopeId: input.enrichmentPlan.scopeId, noteId: enrichment.noteId };
      targets.push(current < maximum
        ? target({
            stage,
            identity: enrichment.noteId,
            state: "QUEUED",
            priority: enrichment.priority,
            scopeId: input.enrichmentPlan.scopeId,
            noteId: enrichment.noteId,
            reason: enrichment.reasons.join(";"),
            now: input.createdAt,
          })
        : skippedByBudget(stage, enrichment.noteId, enrichment.priority, references, input.createdAt));
      if (stage === "DETAIL") detailCount += 1;
      else commentCount += 1;
    }
  }

  for (const blocked of input.enrichmentPlan.blockedTargets) {
    const stages = unique(blocked.reasons.flatMap(blockedStage)) as CollectionStage[];
    for (const stage of stages) {
      const reasons = blocked.reasons.filter((reason) => blockedStage(reason).includes(stage));
      targets.push(target({
        stage,
        identity: blocked.noteId,
        state: "BLOCKED",
        priority: 100,
        scopeId: input.enrichmentPlan.scopeId,
        noteId: blocked.noteId,
        error: {
          targetId: blocked.noteId,
          category: reasons.some((reason) => reason.endsWith("HUMAN_REQUIRED")) ? "NEEDS_HUMAN" : "POLICY_BLOCKED",
          code: `PREBLOCKED_${stage}`,
          message: reasons.join(";"),
          retryable: false,
        },
        reason: reasons.join(";"),
        now: input.createdAt,
      }));
    }
  }

  const ledger: CollectionRunLedger = {
    schemaVersion: CONTRACT_VERSION,
    runId: input.runId,
    taskId: input.keywordPlan.taskId,
    keywordPlanId: input.keywordPlan.planId,
    enrichmentPlanId: input.enrichmentPlan.planId,
    status: targets.some((item) => item.state === "QUEUED")
      ? "READY"
      : targets.some((item) => item.state === "BLOCKED" || item.state === "SKIPPED")
        ? "COMPLETED_WITH_BLOCKS"
        : "COMPLETED",
    budget: { ...input.budget },
    targets: sortTargets(targets),
    recoveryCount: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  assertContract<CollectionRunLedger>("CollectionRunLedger", ledger);
  return ledger;
}

function mutateTarget(
  ledger: CollectionRunLedger,
  targetIdValue: string,
  now: string,
  mutate: (current: CollectionRunTarget) => CollectionRunTarget,
): CollectionRunLedger {
  const index = ledger.targets.findIndex((item) => item.targetId === targetIdValue);
  if (index < 0) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_TARGET_NOT_FOUND",
      message: "The collection target does not exist in this run ledger.",
      targetId: targetIdValue,
      retryable: false,
    });
  }
  const next = structuredClone(ledger);
  next.targets[index] = mutate(next.targets[index]);
  next.updatedAt = now;
  next.status = deriveStatus(next, "RUNNING");
  assertContract<CollectionRunLedger>("CollectionRunLedger", next);
  return next;
}

function deriveStatus(ledger: CollectionRunLedger, activeStatus: CollectionRunStatus): CollectionRunStatus {
  if (ledger.status === "PAUSED" || ledger.status === "CANCELLED") return ledger.status;
  if (ledger.targets.some((item) => item.state === "QUEUED" || item.state === "IN_PROGRESS")) return activeStatus;
  if (ledger.targets.some((item) => item.state === "FAILED")) return "FAILED";
  if (ledger.targets.some((item) => item.state === "BLOCKED" || item.state === "SKIPPED")) return "COMPLETED_WITH_BLOCKS";
  return "COMPLETED";
}

export function claimNextCollectionTarget(
  ledger: CollectionRunLedger,
  now: string,
): { ledger: CollectionRunLedger; target: CollectionRunTarget | null } {
  assertContract<CollectionRunLedger>("CollectionRunLedger", ledger);
  if (["PAUSED", "COMPLETED", "COMPLETED_WITH_BLOCKS", "FAILED", "CANCELLED"].includes(ledger.status)) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_RUN_NOT_CLAIMABLE",
      message: `Collection run cannot dispatch work while ${ledger.status}.`,
      targetId: ledger.runId,
      retryable: false,
    });
  }
  const nextTarget = ledger.targets.find((item) => item.state === "QUEUED");
  if (!nextTarget) {
    const settled = structuredClone(ledger);
    settled.status = deriveStatus(settled, "RUNNING");
    settled.updatedAt = now;
    return { ledger: settled, target: null };
  }
  const nextLedger = mutateTarget(ledger, nextTarget.targetId, now, (current) => ({
    ...current,
    state: "IN_PROGRESS",
    attempts: current.attempts + 1,
    lastError: null,
    dispositionReason: null,
    updatedAt: now,
  }));
  return {
    ledger: nextLedger,
    target: nextLedger.targets.find((item) => item.targetId === nextTarget.targetId) ?? null,
  };
}

export function completeCollectionTarget(
  ledger: CollectionRunLedger,
  targetIdValue: string,
  evidenceEnvelopeIds: string[],
  now: string,
): CollectionRunLedger {
  const evidence = unique(evidenceEnvelopeIds);
  if (evidence.length === 0) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_EVIDENCE_REQUIRED",
      message: "A collection target cannot be completed without evidence envelope IDs.",
      targetId: targetIdValue,
      retryable: false,
    });
  }
  return mutateTarget(ledger, targetIdValue, now, (current) => {
    if (current.state !== "IN_PROGRESS") {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_TARGET_NOT_IN_PROGRESS",
        message: "Only an in-progress collection target can be completed.",
        targetId: targetIdValue,
        retryable: false,
      });
    }
    return {
      ...current,
      state: "COMPLETED",
      evidenceEnvelopeIds: unique([...current.evidenceEnvelopeIds, ...evidence]),
      lastError: null,
      dispositionReason: null,
      updatedAt: now,
    };
  });
}

export function blockCollectionTarget(
  ledger: CollectionRunLedger,
  targetIdValue: string,
  error: TaskError,
  now: string,
  evidenceEnvelopeIds: string[] = [],
): CollectionRunLedger {
  if (error.retryable) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "RETRYABLE_ERROR_CANNOT_BLOCK",
      message: "Retryable failures belong in the retry queue, not the blocked target list.",
      targetId: targetIdValue,
      retryable: false,
    });
  }
  return mutateTarget(ledger, targetIdValue, now, (current) => {
    if (current.state !== "IN_PROGRESS") {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_TARGET_NOT_IN_PROGRESS",
        message: "Only an in-progress collection target can be blocked.",
        targetId: targetIdValue,
        retryable: false,
      });
    }
    return {
      ...current,
      state: "BLOCKED",
      evidenceEnvelopeIds: unique([...current.evidenceEnvelopeIds, ...evidenceEnvelopeIds]),
      lastError: { ...error, targetId: targetIdValue },
      errorHistory: [...current.errorHistory, { ...error, targetId: targetIdValue }],
      dispositionReason: error.code,
      updatedAt: now,
    };
  });
}

export function failCollectionTarget(
  ledger: CollectionRunLedger,
  targetIdValue: string,
  error: TaskError,
  now: string,
  evidenceEnvelopeIds: string[] = [],
): CollectionRunLedger {
  return mutateTarget(ledger, targetIdValue, now, (current) => {
    if (current.state !== "IN_PROGRESS") {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_TARGET_NOT_IN_PROGRESS",
        message: "Only an in-progress collection target can fail.",
        targetId: targetIdValue,
        retryable: false,
      });
    }
    return {
      ...current,
      state: "FAILED",
      evidenceEnvelopeIds: unique([...current.evidenceEnvelopeIds, ...evidenceEnvelopeIds]),
      lastError: { ...error, targetId: targetIdValue },
      errorHistory: [...current.errorHistory, { ...error, targetId: targetIdValue }],
      dispositionReason: error.code,
      updatedAt: now,
    };
  });
}

export function retryCollectionTarget(
  ledger: CollectionRunLedger,
  targetIdValue: string,
  error: TaskError,
  now: string,
  evidenceEnvelopeIds: string[] = [],
): CollectionRunLedger {
  if (error.category !== "RETRYABLE" || !error.retryable) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "NON_RETRYABLE_COLLECTION_TARGET",
      message: "Only retryable collection failures can return to the queue.",
      targetId: targetIdValue,
      retryable: false,
    });
  }
  return mutateTarget(ledger, targetIdValue, now, (current) => {
    if (current.state !== "IN_PROGRESS") {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_TARGET_NOT_IN_PROGRESS",
        message: "Only an in-progress collection target can be retried.",
        targetId: targetIdValue,
        retryable: false,
      });
    }
    const routed = { ...error, targetId: targetIdValue };
    return {
      ...current,
      state: "QUEUED",
      evidenceEnvelopeIds: unique([...current.evidenceEnvelopeIds, ...evidenceEnvelopeIds]),
      lastError: routed,
      errorHistory: [...current.errorHistory, routed],
      dispositionReason: "RETRY_SCHEDULED",
      updatedAt: now,
    };
  });
}

export function pauseCollectionRun(ledger: CollectionRunLedger, now: string): CollectionRunLedger {
  if (ledger.targets.some((item) => item.state === "IN_PROGRESS")) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_PAUSE_NOT_AT_SAFE_POINT",
      message: "Pause is allowed only when no collection target is in progress.",
      targetId: ledger.runId,
      retryable: false,
    });
  }
  if (ledger.status !== "READY" && ledger.status !== "RUNNING") {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_RUN_NOT_PAUSABLE",
      message: `Collection run cannot be paused while ${ledger.status}.`,
      targetId: ledger.runId,
      retryable: false,
    });
  }
  const next = structuredClone(ledger);
  next.status = "PAUSED";
  next.updatedAt = now;
  assertContract<CollectionRunLedger>("CollectionRunLedger", next);
  return next;
}

export function resumeCollectionRun(ledger: CollectionRunLedger, now: string): CollectionRunLedger {
  if (ledger.status !== "PAUSED") {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "COLLECTION_RUN_NOT_PAUSED",
      message: "Only a paused collection run can be resumed.",
      targetId: ledger.runId,
      retryable: false,
    });
  }
  const next = structuredClone(ledger);
  next.status = next.targets.some((item) => item.state === "QUEUED") ? "READY" : deriveStatus({ ...next, status: "READY" }, "READY");
  next.updatedAt = now;
  assertContract<CollectionRunLedger>("CollectionRunLedger", next);
  return next;
}

export function recoverInterruptedCollectionRun(ledger: CollectionRunLedger, now: string): CollectionRunLedger {
  const interrupted = ledger.targets.filter((item) => item.state === "IN_PROGRESS");
  if (interrupted.length === 0) return ledger;
  const next = structuredClone(ledger);
  next.targets = next.targets.map((item) => item.state === "IN_PROGRESS"
    ? {
        ...item,
        state: "QUEUED" as const,
        lastError: null,
        dispositionReason: "RECOVERED_AFTER_INTERRUPTION",
        updatedAt: now,
      }
    : item);
  next.recoveryCount += 1;
  next.status = "READY";
  next.updatedAt = now;
  assertContract<CollectionRunLedger>("CollectionRunLedger", next);
  return next;
}

export function summarizeCollectionRun(ledger: CollectionRunLedger): CollectionRunProgress {
  const initial = (): CollectionStageProgress => ({
    total: 0,
    eligible: 0,
    attempted: 0,
    queued: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  });
  const progress: CollectionRunProgress = {
    RANKING_SNAPSHOT: initial(),
    KEYWORD_SEARCH: initial(),
    DETAIL: initial(),
    COMMENTS: initial(),
  };
  for (const item of ledger.targets) {
    const stage = progress[item.stage];
    stage.total += 1;
    if (item.state !== "SKIPPED" && item.state !== "BLOCKED") stage.eligible += 1;
    if (item.attempts > 0) stage.attempted += 1;
    if (item.state === "QUEUED") stage.queued += 1;
    if (item.state === "IN_PROGRESS") stage.inProgress += 1;
    if (item.state === "COMPLETED") stage.completed += 1;
    if (item.state === "BLOCKED") stage.blocked += 1;
    if (item.state === "FAILED") stage.failed += 1;
    if (item.state === "SKIPPED") stage.skipped += 1;
  }
  return progress;
}
