import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTRACT_VERSION,
  type CollectionRunBudget,
  type EnrichmentPlan,
  type KeywordPlan,
} from "../../contracts/src/index.ts";
import {
  claimNextCollectionTarget,
  completeCollectionTarget,
  createCollectionRunLedger,
  pauseCollectionRun,
  resumeCollectionRun,
  summarizeCollectionRun,
} from "../src/collection-run-ledger.ts";
import { CollectionRunWorkbench } from "../src/collection-run-workbench.ts";
import { FileEvidenceStore } from "../src/file-store.ts";

const keywordPlan: KeywordPlan = {
  schemaVersion: CONTRACT_VERSION,
  planId: "keywords-001",
  taskId: "task-collection-001",
  policy: {
    maxDepth: 2,
    maxKeywords: 10,
    maxChildrenPerKeyword: 3,
    noteDetailsPerKeyword: 2,
    maxEstimatedNoteDetails: 20,
    excludedTerms: [],
  },
  nodes: [
    { keywordId: "kw-seed", value: "AI工具", normalized: "ai工具", depth: 0, source: "SEED", status: "QUEUED" },
    { keywordId: "kw-child-a", value: "AI效率", normalized: "ai效率", depth: 1, source: "SUGGESTION", status: "QUEUED" },
    { keywordId: "kw-child-b", value: "AI办公", normalized: "ai办公", depth: 1, source: "SUGGESTION", status: "QUEUED" },
  ],
  edges: [
    { parentKeywordId: "kw-seed", childKeywordId: "kw-child-a", source: "SUGGESTION" },
    { parentKeywordId: "kw-seed", childKeywordId: "kw-child-b", source: "SUGGESTION" },
  ],
  estimatedNoteDetails: 6,
  truncation: {
    hitKeywordLimit: false,
    hitNoteBudget: false,
    prunedByDepth: 0,
    prunedByExclusion: 0,
    prunedByChildLimit: 0,
  },
  createdAt: "2026-09-25T00:00:00.000Z",
};

const enrichmentPlan: EnrichmentPlan = {
  schemaVersion: CONTRACT_VERSION,
  planId: "enrichment-001",
  scopeId: "ranking:discovery:daily",
  tasks: [
    {
      targetId: "enrich-note-a",
      noteId: "note-a",
      priority: 95,
      stages: ["DETAIL", "COMMENTS"],
      reasons: ["NEW_ENTRY", "DETAIL_NOT_OBSERVED", "COMMENTS_NOT_OBSERVED"],
      rankingSignal: "NEW_ENTRY",
      currentRank: 1,
    },
    {
      targetId: "enrich-note-b",
      noteId: "note-b",
      priority: 80,
      stages: ["DETAIL", "COMMENTS"],
      reasons: ["RISING", "DETAIL_PARTIAL", "COMMENTS_PARTIAL"],
      rankingSignal: "RISING",
      currentRank: 2,
    },
  ],
  blockedTargets: [{
    noteId: "note-c",
    reasons: ["DETAIL_DRIFTED", "COMMENTS_HUMAN_REQUIRED"],
    rankingSignal: "NEW_ENTRY",
  }],
  skippedDueToBudget: 0,
  createdAt: "2026-09-25T00:01:00.000Z",
};

const tightBudget: CollectionRunBudget = {
  maxRankingSnapshots: 1,
  maxKeywordSearches: 2,
  maxDetailTargets: 1,
  maxCommentTargets: 1,
};

function createLedger(budget: CollectionRunBudget = tightBudget) {
  return createCollectionRunLedger({
    runId: "collection-run-001",
    keywordPlan,
    enrichmentPlan,
    rankingScopeIds: ["ranking:discovery:daily", "ranking:search:ai-tools"],
    budget,
    createdAt: "2026-09-25T00:02:00.000Z",
  });
}

test("collection run preserves every target and exposes budget skips instead of silently dropping them", () => {
  const ledger = createLedger();
  const progress = summarizeCollectionRun(ledger);

  assert.equal(ledger.status, "READY");
  assert.deepEqual(progress.RANKING_SNAPSHOT, {
    total: 2, eligible: 1, attempted: 0, queued: 1, inProgress: 0, completed: 0, blocked: 0, failed: 0, skipped: 1,
  });
  assert.equal(progress.KEYWORD_SEARCH.total, 3);
  assert.equal(progress.KEYWORD_SEARCH.queued, 2);
  assert.equal(progress.KEYWORD_SEARCH.skipped, 1);
  assert.equal(progress.DETAIL.queued, 1);
  assert.equal(progress.DETAIL.blocked, 1);
  assert.equal(progress.DETAIL.skipped, 1);
  assert.equal(progress.COMMENTS.queued, 1);
  assert.equal(progress.COMMENTS.blocked, 1);
  assert.equal(progress.COMMENTS.skipped, 1);
});

test("ranking snapshot dispatches first and completion requires evidence", () => {
  const first = claimNextCollectionTarget(createLedger(), "2026-09-25T00:03:00.000Z");
  assert.equal(first.target?.stage, "RANKING_SNAPSHOT");
  assert.equal(first.target?.scopeId, "ranking:discovery:daily");
  assert.equal(first.target?.attempts, 1);
  assert.throws(
    () => completeCollectionTarget(first.ledger, first.target!.targetId, [], "2026-09-25T00:04:00.000Z"),
    /without evidence envelope IDs/,
  );
  const completed = completeCollectionTarget(
    first.ledger,
    first.target!.targetId,
    ["raw-ranking-001", "raw-ranking-001"],
    "2026-09-25T00:04:00.000Z",
  );
  const saved = completed.targets.find((item) => item.targetId === first.target!.targetId);
  assert.equal(saved?.state, "COMPLETED");
  assert.deepEqual(saved?.evidenceEnvelopeIds, ["raw-ranking-001"]);
});

test("blocked and budget-skipped targets are never claimed and the run closes with an explicit blocked result", () => {
  let ledger = createLedger();
  let tick = 3;
  while (ledger.targets.some((item) => item.state === "QUEUED")) {
    const claimed = claimNextCollectionTarget(ledger, `2026-09-25T00:${String(tick).padStart(2, "0")}:00.000Z`);
    assert.ok(claimed.target);
    assert.notEqual(claimed.target!.state, "BLOCKED");
    assert.notEqual(claimed.target!.state, "SKIPPED");
    tick += 1;
    ledger = completeCollectionTarget(
      claimed.ledger,
      claimed.target!.targetId,
      [`evidence-${claimed.target!.targetId}`],
      `2026-09-25T00:${String(tick).padStart(2, "0")}:00.000Z`,
    );
    tick += 1;
  }
  assert.equal(ledger.status, "COMPLETED_WITH_BLOCKS");
  assert.equal(ledger.targets.filter((item) => item.state === "BLOCKED").length, 2);
  assert.equal(ledger.targets.filter((item) => item.state === "SKIPPED").length, 4);
});

test("pause is allowed only at a safe point and resume restores dispatch", () => {
  const paused = pauseCollectionRun(createLedger(), "2026-09-25T00:03:00.000Z");
  assert.equal(paused.status, "PAUSED");
  assert.throws(() => claimNextCollectionTarget(paused, "2026-09-25T00:04:00.000Z"), /cannot dispatch work/);
  const resumed = resumeCollectionRun(paused, "2026-09-25T00:05:00.000Z");
  assert.equal(resumed.status, "READY");
  const claimed = claimNextCollectionTarget(resumed, "2026-09-25T00:06:00.000Z");
  assert.throws(() => pauseCollectionRun(claimed.ledger, "2026-09-25T00:07:00.000Z"), /in progress/);
});

test("persisted collection run recovers one interrupted target after process reconstruction", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-collection-run-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  const firstProcess = new CollectionRunWorkbench(new FileEvidenceStore(databasePath));
  await firstProcess.create({
    runId: "persisted-run-001",
    keywordPlan,
    enrichmentPlan,
    rankingScopeIds: ["ranking:discovery:daily"],
    budget: tightBudget,
    createdAt: "2026-09-25T00:02:00.000Z",
  });
  const firstClaim = await firstProcess.claim("persisted-run-001", "2026-09-25T00:03:00.000Z");
  assert.equal(firstClaim?.stage, "RANKING_SNAPSHOT");

  const reconstructed = new CollectionRunWorkbench(new FileEvidenceStore(databasePath));
  const recovered = await reconstructed.recover("persisted-run-001", "2026-09-25T00:04:00.000Z");
  assert.equal(recovered.recoveryCount, 1);
  assert.equal(recovered.targets.find((item) => item.targetId === firstClaim!.targetId)?.state, "QUEUED");
  const secondClaim = await reconstructed.claim("persisted-run-001", "2026-09-25T00:05:00.000Z");
  assert.equal(secondClaim?.targetId, firstClaim?.targetId);
  assert.equal(secondClaim?.attempts, 2);
});
