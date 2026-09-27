import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  ContractValidationError,
  assertContract,
  validateContract,
  type ExportReceipt,
  type CollectionRunLedger,
  type EnrichmentPlan,
  type KeywordPlan,
  type NoteCompletenessLedger,
  type RankingSnapshot,
  type RetryQueueSnapshot,
  type TaskSpec,
} from "../src/index.ts";

const validTask: TaskSpec = {
  schemaVersion: CONTRACT_VERSION,
  taskId: "task-001",
  projectId: "project-001",
  goal: "Verify the local evidence loop.",
  seedKeywords: ["AI工具"],
  limits: { maxSearchResults: 20, maxNoteDetails: 3 },
  authorization: {
    readVisiblePages: true,
    externalApi: false,
    upload: false,
    publish: false,
  },
  createdAt: "2026-09-24T00:00:00.000Z",
};

test("TaskSpec accepts the bounded offline M1 contract", () => {
  assert.deepEqual(validateContract("TaskSpec", validTask), { ok: true, errors: [] });
  assert.doesNotThrow(() => assertContract<TaskSpec>("TaskSpec", validTask));
});

test("TaskSpec rejects limits outside the M1 boundary", () => {
  const invalid = structuredClone(validTask) as TaskSpec;
  invalid.limits.maxSearchResults = 21;
  invalid.limits.maxNoteDetails = 4;
  const result = validateContract("TaskSpec", invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /maxSearchResults/);
  assert.match(result.errors.join("\n"), /maxNoteDetails/);
  assert.throws(
    () => assertContract<TaskSpec>("TaskSpec", invalid),
    (error: unknown) => error instanceof ContractValidationError && error.contract === "TaskSpec",
  );
});

test("ExportReceipt requires a verifiable SHA-256 hash", () => {
  const receipt: ExportReceipt = {
    schemaVersion: CONTRACT_VERSION,
    exportId: "export-001",
    taskId: validTask.taskId,
    format: "JSON",
    outputPath: "artifacts/example.json",
    rowCount: 3,
    failedCount: 1,
    sha256: "a".repeat(64),
    fieldsVersion: "1.0.0",
    createdAt: "2026-09-24T01:00:00.000Z",
  };
  assert.equal(validateContract("ExportReceipt", receipt).ok, true);
  assert.equal(validateContract("ExportReceipt", { ...receipt, sha256: "short" }).ok, false);
});

test("KeywordPlan requires bounded policy and unique keyword identities", () => {
  const plan: KeywordPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: "plan-001",
    taskId: validTask.taskId,
    policy: {
      maxDepth: 2,
      maxKeywords: 10,
      maxChildrenPerKeyword: 3,
      noteDetailsPerKeyword: 3,
      maxEstimatedNoteDetails: 30,
      excludedTerms: ["招聘"],
    },
    nodes: [{
      keywordId: "kw-001",
      value: "AI工具",
      normalized: "ai工具",
      depth: 0,
      source: "SEED",
      status: "QUEUED",
    }],
    edges: [],
    estimatedNoteDetails: 3,
    truncation: {
      hitKeywordLimit: false,
      hitNoteBudget: false,
      prunedByDepth: 0,
      prunedByExclusion: 0,
      prunedByChildLimit: 0,
    },
    createdAt: "2026-09-24T00:00:00.000Z",
  };
  assert.equal(validateContract("KeywordPlan", plan).ok, true);
  assert.equal(validateContract("KeywordPlan", { ...plan, nodes: [...plan.nodes, plan.nodes[0]] }).ok, false);
});

test("RetryQueueSnapshot rejects duplicate targets and invalid attempt bounds", () => {
  const queue: RetryQueueSnapshot = {
    schemaVersion: CONTRACT_VERSION,
    taskId: validTask.taskId,
    items: [{
      targetId: "note-002",
      state: "QUEUED",
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-09-24T00:00:01.000Z",
      lastError: {
        targetId: "note-002",
        category: "RETRYABLE",
        code: "TEMPORARY_READ_FAILURE",
        message: "Temporary read failure.",
        retryable: true,
      },
    }],
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
  assert.equal(validateContract("RetryQueueSnapshot", queue).ok, true);
  assert.equal(validateContract("RetryQueueSnapshot", { ...queue, items: [...queue.items, queue.items[0]] }).ok, false);
  assert.equal(validateContract("RetryQueueSnapshot", {
    ...queue,
    items: [{ ...queue.items[0], maxAttempts: 0 }],
  }).ok, false);
});

test("RankingSnapshot never calls a short observation COMPLETE", () => {
  const snapshot: RankingSnapshot = {
    schemaVersion: CONTRACT_VERSION,
    snapshotId: "snapshot-001",
    scopeId: "榜单:发现页:日榜",
    scopeLabel: "发现页日榜",
    coverage: "COMPLETE",
    expectedSlots: 2,
    entries: [
      { noteId: "note-a", rank: 1, sourceEnvelopeId: "raw-a" },
      { noteId: "note-b", rank: 2, sourceEnvelopeId: "raw-b" },
    ],
    observedAt: "2026-09-24T04:00:00.000Z",
  };
  assert.equal(validateContract("RankingSnapshot", snapshot).ok, true);
  assert.equal(validateContract("RankingSnapshot", { ...snapshot, entries: snapshot.entries.slice(0, 1) }).ok, false);
  assert.equal(validateContract("RankingSnapshot", {
    ...snapshot,
    entries: [snapshot.entries[0], { ...snapshot.entries[1], rank: 3 }],
  }).ok, false);
});

test("NoteCompletenessLedger requires auditable captured comment identities", () => {
  const ledger: NoteCompletenessLedger = {
    schemaVersion: CONTRACT_VERSION,
    noteId: "note-a",
    detail: {
      status: "COMPLETE",
      requiredFields: ["title"],
      presentFields: ["title"],
      missingFields: [],
      evidenceEnvelopeIds: ["raw-detail-a"],
    },
    comments: {
      status: "COMPLETE",
      platformDeclaredTotal: 2,
      capturedTopLevelIds: ["comment-1"],
      capturedReplyIds: ["reply-1"],
      capturedTopLevelCount: 1,
      capturedReplyCount: 1,
      capturedUniqueCount: 2,
      countGap: 0,
      topLevelPaginationExhausted: true,
      unresolvedReplyThreads: 0,
      replyThreads: [{
        parentCommentId: "comment-1",
        declaredReplyCount: 1,
        capturedReplyIds: ["reply-1"],
        capturedReplyCount: 1,
        expansionExhausted: true,
        missingReplyCount: 0,
      }],
      nextCursor: null,
      evidenceEnvelopeIds: ["raw-comments-a"],
    },
    overallStatus: "COMPLETE",
    observationCount: 2,
    updatedAt: "2026-09-24T04:10:00.000Z",
  };
  assert.equal(validateContract("NoteCompletenessLedger", ledger).ok, true);
  assert.equal(validateContract("NoteCompletenessLedger", {
    ...ledger,
    comments: { ...ledger.comments, capturedReplyCount: 2 },
  }).ok, false);
  assert.equal(validateContract("NoteCompletenessLedger", {
    ...ledger,
    comments: { ...ledger.comments, topLevelPaginationExhausted: false },
  }).ok, false);
});

test("EnrichmentPlan keeps blocked targets outside the automatic task queue", () => {
  const plan: EnrichmentPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: "enrichment-001",
    scopeId: "榜单:发现页:日榜",
    tasks: [],
    blockedTargets: [{
      noteId: "note-a",
      reasons: ["COMMENTS_HUMAN_REQUIRED"],
      rankingSignal: "NEW_ENTRY",
    }],
    skippedDueToBudget: 0,
    createdAt: "2026-09-24T04:20:00.000Z",
  };
  assert.equal(validateContract("EnrichmentPlan", plan).ok, true);
  assert.equal(validateContract("EnrichmentPlan", { ...plan, blockedTargets: [] }).ok, true);
  assert.equal(validateContract("EnrichmentPlan", {
    ...plan,
    blockedTargets: [...plan.blockedTargets, plan.blockedTargets[0]],
  }).ok, false);
});

test("CollectionRunLedger requires evidence, blocking errors, and explicit skip reasons", () => {
  const ledger: CollectionRunLedger = {
    schemaVersion: CONTRACT_VERSION,
    runId: "run-001",
    taskId: "task-001",
    keywordPlanId: "keywords-001",
    enrichmentPlanId: "enrichment-001",
    status: "COMPLETED_WITH_BLOCKS",
    budget: {
      maxRankingSnapshots: 1,
      maxKeywordSearches: 1,
      maxDetailTargets: 1,
      maxCommentTargets: 1,
    },
    targets: [{
      targetId: "target-ranking-001",
      stage: "RANKING_SNAPSHOT",
      state: "COMPLETED",
      priority: 100,
      keywordId: null,
      query: null,
      scopeId: "ranking:daily",
      noteId: null,
      attempts: 1,
      evidenceEnvelopeIds: ["raw-ranking-001"],
      lastError: null,
      errorHistory: [],
      dispositionReason: null,
      updatedAt: "2026-09-25T00:01:00.000Z",
    }, {
      targetId: "target-detail-001",
      stage: "DETAIL",
      state: "SKIPPED",
      priority: 80,
      keywordId: null,
      query: null,
      scopeId: "ranking:daily",
      noteId: "note-a",
      attempts: 0,
      evidenceEnvelopeIds: [],
      lastError: null,
      errorHistory: [],
      dispositionReason: "BUDGET_LIMIT",
      updatedAt: "2026-09-25T00:01:00.000Z",
    }],
    recoveryCount: 0,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:01:00.000Z",
  };
  assert.equal(validateContract("CollectionRunLedger", ledger).ok, true);
  assert.equal(validateContract("CollectionRunLedger", {
    ...ledger,
    targets: [{ ...ledger.targets[0], evidenceEnvelopeIds: [] }],
  }).ok, false);
  assert.equal(validateContract("CollectionRunLedger", {
    ...ledger,
    targets: [{ ...ledger.targets[1], dispositionReason: null }],
  }).ok, false);
});
