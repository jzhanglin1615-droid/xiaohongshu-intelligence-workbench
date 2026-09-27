import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  type EnrichmentPlan,
  type KeywordPlan,
} from "../../contracts/src/index.ts";
import { FixtureCollector } from "../../../apps/fixture-runner/src/fixture-parser.ts";
import { CollectionRunExecutor } from "../src/collection-run-executor.ts";
import { CollectionRunWorkbench } from "../src/collection-run-workbench.ts";
import { WorkbenchError } from "../src/errors.ts";
import { FileEvidenceStore } from "../src/file-store.ts";
import { FixedClock } from "../src/runtime.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const keywordPlan: KeywordPlan = {
  schemaVersion: CONTRACT_VERSION,
  planId: "executor-keywords-001",
  taskId: "executor-task-001",
  policy: {
    maxDepth: 1,
    maxKeywords: 1,
    maxChildrenPerKeyword: 0,
    noteDetailsPerKeyword: 3,
    maxEstimatedNoteDetails: 3,
    excludedTerms: [],
  },
  nodes: [{ keywordId: "kw-ai-tools", value: "AI工具", normalized: "ai工具", depth: 0, source: "SEED", status: "QUEUED" }],
  edges: [],
  estimatedNoteDetails: 3,
  truncation: { hitKeywordLimit: false, hitNoteBudget: false, prunedByDepth: 0, prunedByExclusion: 0, prunedByChildLimit: 0 },
  createdAt: "2026-09-24T00:00:00.000Z",
};

const enrichmentPlan: EnrichmentPlan = {
  schemaVersion: CONTRACT_VERSION,
  planId: "executor-enrichment-001",
  scopeId: "ranking:discovery:daily",
  tasks: ["note-001", "note-002", "note-003"].map((noteId, index) => ({
    targetId: `enrich-${noteId}`,
    noteId,
    priority: 95 - index * 5,
    stages: ["DETAIL", "COMMENTS"],
    reasons: ["NEW_ENTRY", "DETAIL_NOT_OBSERVED", "COMMENTS_NOT_OBSERVED"],
    rankingSignal: "NEW_ENTRY",
    currentRank: index + 1,
  })),
  blockedTargets: [],
  skippedDueToBudget: 0,
  createdAt: "2026-09-24T00:00:01.000Z",
};

function evidenceEnvelope(id: string, kind: "NOTE_DETAIL" | "COMMENT_PAGE") {
  return {
    schemaVersion: CONTRACT_VERSION,
    envelopeId: id,
    kind,
    sourceUrl: "https://www.xiaohongshu.com/explore/note-gap",
    collectedAt: "2026-09-25T00:00:00.000Z",
    parserVersion: "completeness-gate-test/1.0.0",
    payload: { noteId: "note-gap", evidenceId: id },
    evidence: { fixturePath: `contract://${id}`, sha256: "a".repeat(64) },
  };
}

async function createGapRun(store: FileEvidenceStore, runId: string, stage: "DETAIL" | "COMMENTS") {
  await new CollectionRunWorkbench(store).create({
    runId,
    keywordPlan: { ...keywordPlan, planId: `${runId}-keywords`, taskId: `${runId}-task` },
    enrichmentPlan: {
      ...enrichmentPlan,
      planId: `${runId}-enrichment`,
      tasks: [{
        ...enrichmentPlan.tasks[0],
        targetId: `${runId}-target`,
        noteId: "note-gap",
        stages: [stage],
      }],
    },
    rankingScopeIds: [],
    budget: {
      maxRankingSnapshots: 0,
      maxKeywordSearches: 0,
      maxDetailTargets: stage === "DETAIL" ? 1 : 0,
      maxCommentTargets: stage === "COMMENTS" ? 1 : 0,
    },
    createdAt: "2026-09-25T00:00:00.000Z",
  });
}

test("collection executor closes ranking, search, detail, comments, evidence, normalization, and completeness", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-collection-executor-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  const runs = new CollectionRunWorkbench(store);
  await runs.create({
    runId: "executor-run-001",
    keywordPlan,
    enrichmentPlan: { ...enrichmentPlan, tasks: enrichmentPlan.tasks.slice(0, 2) },
    rankingScopeIds: ["ranking:discovery:daily"],
    budget: { maxRankingSnapshots: 1, maxKeywordSearches: 1, maxDetailTargets: 3, maxCommentTargets: 3 },
    createdAt: "2026-09-24T00:00:02.000Z",
  });

  const executor = new CollectionRunExecutor({
    collector: new FixtureCollector(path.join(projectRoot, "fixtures")),
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
  });
  const receipt = await executor.execute("executor-run-001");
  const ledger = await runs.get("executor-run-001");

  assert.equal(receipt.status, "COMPLETED");
  assert.equal(receipt.dispatched, 6);
  assert.equal(receipt.completed, 6);
  assert.equal(receipt.normalizedNotes, 2);
  assert.equal(receipt.failureRoutes.length, 0);
  assert.equal(ledger.targets.every((target) => target.state === "COMPLETED"), true);
  assert.equal((await store.listNotes()).length, 2);
  assert.equal((await store.listRawEnvelopes()).length, 5);
  assert.equal((await store.getRankingLedger("ranking:discovery:daily"))?.snapshots.length, 1);
  assert.equal((await store.getCompletenessLedger("note-001"))?.overallStatus, "COMPLETE");
  assert.equal((await store.getCompletenessLedger("note-002"))?.comments.status, "COMPLETE");
});

test("retryable collection failures are bounded and remain auditable after success", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-collection-retry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  const runs = new CollectionRunWorkbench(store);
  await runs.create({
    runId: "executor-retry-001",
    keywordPlan,
    enrichmentPlan: { ...enrichmentPlan, planId: "empty-enrichment", tasks: [] },
    rankingScopeIds: [],
    budget: { maxRankingSnapshots: 0, maxKeywordSearches: 1, maxDetailTargets: 0, maxCommentTargets: 0 },
    createdAt: "2026-09-24T00:00:02.000Z",
  });
  const fixture = new FixtureCollector(path.join(projectRoot, "fixtures"));
  let calls = 0;
  const executor = new CollectionRunExecutor({
    collector: {
      async collectTarget(target) {
        calls += 1;
        if (calls === 1) {
          throw new WorkbenchError({ category: "RETRYABLE", code: "TEMPORARY_FIXTURE_FAILURE", message: "temporary fixture failure", targetId: target.targetId });
        }
        return fixture.collectTarget(target);
      },
    },
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    maxAttemptsPerTarget: 2,
  });
  const receipt = await executor.execute("executor-retry-001");
  const ledger = await runs.get("executor-retry-001");
  const target = ledger.targets[0];

  assert.equal(receipt.status, "COMPLETED");
  assert.equal(receipt.retried, 1);
  assert.equal(receipt.completed, 1);
  assert.equal(target.attempts, 2);
  assert.equal(target.errorHistory.length, 1);
  assert.equal(target.errorHistory[0].code, "TEMPORARY_FIXTURE_FAILURE");
});

for (const route of [
  { category: "NEEDS_HUMAN", outcome: "BLOCKED", status: "COMPLETED_WITH_BLOCKS" },
  { category: "POLICY_BLOCKED", outcome: "BLOCKED", status: "COMPLETED_WITH_BLOCKS" },
  { category: "PERMANENT", outcome: "FAILED", status: "FAILED" },
] as const) {
  test(`collection executor routes ${route.category} failures to ${route.outcome}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `xhs-collection-${route.category.toLowerCase()}-`));
    t.after(async () => rm(directory, { recursive: true, force: true }));
    const store = new FileEvidenceStore(path.join(directory, "database.json"));
    const runs = new CollectionRunWorkbench(store);
    const runId = `executor-route-${route.category.toLowerCase()}`;
    await runs.create({
      runId,
      keywordPlan: { ...keywordPlan, planId: `${runId}-plan`, taskId: `${runId}-task` },
      enrichmentPlan: { ...enrichmentPlan, planId: `${runId}-enrichment`, tasks: [] },
      rankingScopeIds: [],
      budget: { maxRankingSnapshots: 0, maxKeywordSearches: 1, maxDetailTargets: 0, maxCommentTargets: 0 },
      createdAt: "2026-09-24T00:00:02.000Z",
    });
    const executor = new CollectionRunExecutor({
      collector: {
        async collectTarget(target) {
          throw new WorkbenchError({
            category: route.category,
            code: `TEST_${route.category}`,
            message: `forced ${route.category} failure`,
            targetId: target.targetId,
            retryable: false,
          });
        },
      },
      store,
      clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    });

    const receipt = await executor.execute(runId);
    const ledger = await runs.get(runId);
    assert.equal(receipt.status, route.status);
    assert.equal(receipt.failureRoutes[0].outcome, route.outcome);
    assert.equal(ledger.targets[0].errorHistory.length, 1);
    assert.equal(ledger.targets[0].lastError?.code, `TEST_${route.category}`);
  });
}

test("retryable collection failures become permanent after the bounded attempt ceiling", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-collection-retry-exhausted-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  const runs = new CollectionRunWorkbench(store);
  await runs.create({
    runId: "executor-retry-exhausted",
    keywordPlan: { ...keywordPlan, planId: "retry-exhausted-plan", taskId: "retry-exhausted-task" },
    enrichmentPlan: { ...enrichmentPlan, planId: "retry-exhausted-enrichment", tasks: [] },
    rankingScopeIds: [],
    budget: { maxRankingSnapshots: 0, maxKeywordSearches: 1, maxDetailTargets: 0, maxCommentTargets: 0 },
    createdAt: "2026-09-24T00:00:02.000Z",
  });
  const executor = new CollectionRunExecutor({
    collector: {
      async collectTarget(target) {
        throw new WorkbenchError({
          category: "RETRYABLE",
          code: "ALWAYS_TRANSIENT",
          message: "forced retry exhaustion",
          targetId: target.targetId,
        });
      },
    },
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    maxAttemptsPerTarget: 2,
  });

  const receipt = await executor.execute("executor-retry-exhausted");
  const target = (await runs.get("executor-retry-exhausted")).targets[0];
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.retried, 1);
  assert.equal(receipt.failed, 1);
  assert.equal(target.attempts, 2);
  assert.equal(target.errorHistory.length, 2);
});

test("partial comments keep every evidence page and close only after pagination and replies are complete", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-comment-gap-closes-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  await createGapRun(store, "comment-gap-closes", "COMMENTS");
  let calls = 0;
  const executor = new CollectionRunExecutor({
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    maxAttemptsPerTarget: 2,
    collector: {
      async collectTarget() {
        calls += 1;
        const envelope = evidenceEnvelope(`comment-gap-page-${calls}`, "COMMENT_PAGE");
        return {
          envelopes: [envelope],
          commentsObservation: calls === 1 ? {
            noteId: "note-gap", observedAt: envelope.collectedAt, access: "VISIBLE" as const,
            platformDeclaredTotal: 3, capturedTopLevelIds: ["c1"],
            replyThreads: [{ parentCommentId: "c1", declaredReplyCount: 2, capturedReplyIds: [], expansionExhausted: false }],
            topLevelPaginationExhausted: false, nextCursor: "cursor-2", evidenceEnvelopeIds: [envelope.envelopeId],
          } : {
            noteId: "note-gap", observedAt: envelope.collectedAt, access: "VISIBLE" as const,
            platformDeclaredTotal: 3, capturedTopLevelIds: ["c1"],
            replyThreads: [{ parentCommentId: "c1", declaredReplyCount: 2, capturedReplyIds: ["r1", "r2"], expansionExhausted: true }],
            topLevelPaginationExhausted: true, nextCursor: null, evidenceEnvelopeIds: [envelope.envelopeId],
          },
        };
      },
    },
  });

  const receipt = await executor.execute("comment-gap-closes");
  const target = (await new CollectionRunWorkbench(store).get("comment-gap-closes")).targets.find((item) => item.stage === "COMMENTS")!;
  assert.equal(receipt.retried, 1);
  assert.equal(target.state, "COMPLETED");
  assert.equal(target.attempts, 2);
  assert.deepEqual(target.evidenceEnvelopeIds, ["comment-gap-page-1", "comment-gap-page-2"]);
  assert.equal(target.errorHistory[0].code, "COMMENTS_COMPLETENESS_PARTIAL");
  assert.equal((await store.getCompletenessLedger("note-gap"))?.comments.status, "COMPLETE");
});

test("comments with an open cursor and unexpanded replies fail explicitly after bounded gap collection", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-comment-gap-exhausted-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  await createGapRun(store, "comment-gap-exhausted", "COMMENTS");
  let calls = 0;
  const executor = new CollectionRunExecutor({
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    maxAttemptsPerTarget: 2,
    collector: {
      async collectTarget() {
        calls += 1;
        const envelope = evidenceEnvelope(`comment-open-page-${calls}`, "COMMENT_PAGE");
        return {
          envelopes: [envelope],
          commentsObservation: {
            noteId: "note-gap", observedAt: envelope.collectedAt, access: "VISIBLE" as const,
            platformDeclaredTotal: 4, capturedTopLevelIds: ["c1"],
            replyThreads: [{ parentCommentId: "c1", declaredReplyCount: 3, capturedReplyIds: ["r1"], expansionExhausted: false }],
            topLevelPaginationExhausted: false, nextCursor: "still-open", evidenceEnvelopeIds: [envelope.envelopeId],
          },
        };
      },
    },
  });

  const receipt = await executor.execute("comment-gap-exhausted");
  const target = (await new CollectionRunWorkbench(store).get("comment-gap-exhausted")).targets.find((item) => item.stage === "COMMENTS")!;
  assert.equal(receipt.status, "FAILED");
  assert.equal(target.state, "FAILED");
  assert.equal(target.attempts, 2);
  assert.deepEqual(target.evidenceEnvelopeIds, ["comment-open-page-1", "comment-open-page-2"]);
  assert.equal(target.errorHistory.length, 2);
  assert.equal(target.errorHistory.every((item) => item.code === "COMMENTS_COMPLETENESS_PARTIAL"), true);
  assert.equal((await store.getCompletenessLedger("note-gap"))?.comments.status, "PARTIAL");
});

test("detail evidence with missing required fields is retained but never marked complete", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-detail-gap-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new FileEvidenceStore(path.join(directory, "database.json"));
  await createGapRun(store, "detail-gap", "DETAIL");
  const executor = new CollectionRunExecutor({
    store,
    clock: new FixedClock("2026-09-25T00:00:00.000Z"),
    maxAttemptsPerTarget: 1,
    collector: {
      async collectTarget() {
        const envelope = evidenceEnvelope("detail-gap-page-1", "NOTE_DETAIL");
        return {
          envelopes: [envelope],
          detailObservation: {
            noteId: "note-gap", observedAt: envelope.collectedAt, access: "VISIBLE" as const,
            requiredFields: ["title", "body", "author", "metrics", "assets"],
            presentFields: ["title"], evidenceEnvelopeIds: [envelope.envelopeId],
          },
        };
      },
    },
  });

  await executor.execute("detail-gap");
  const target = (await new CollectionRunWorkbench(store).get("detail-gap")).targets.find((item) => item.stage === "DETAIL")!;
  assert.equal(target.state, "FAILED");
  assert.deepEqual(target.evidenceEnvelopeIds, ["detail-gap-page-1"]);
  assert.equal(target.lastError?.code, "DETAIL_COMPLETENESS_PARTIAL");
  assert.equal((await store.getCompletenessLedger("note-gap"))?.detail.status, "PARTIAL");
});
