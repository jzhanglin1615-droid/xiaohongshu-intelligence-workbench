import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTRACT_VERSION, type RankingSnapshot } from "../../contracts/src/index.ts";
import { FileEvidenceStore } from "../src/file-store.ts";
import { RankingWorkbench } from "../src/ranking-workbench.ts";

const rankingSnapshot: RankingSnapshot = {
  schemaVersion: CONTRACT_VERSION,
  snapshotId: "ranking-001",
  scopeId: "ranking:discovery:daily",
  scopeLabel: "发现页日榜",
  coverage: "COMPLETE",
  expectedSlots: 1,
  entries: [{ noteId: "note-a", rank: 1, sourceEnvelopeId: "raw-rank-a" }],
  observedAt: "2026-09-24T04:00:00.000Z",
};

test("ranking workbench persists ranking, completeness, and enrichment across process reconstruction", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-ranking-workbench-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");

  const firstProcess = new RankingWorkbench(new FileEvidenceStore(databasePath));
  await firstProcess.recordRankingSnapshot(rankingSnapshot);
  await firstProcess.recordCompleteness({
    noteId: "note-a",
    observedAt: "2026-09-24T04:05:00.000Z",
    detail: {
      access: "VISIBLE",
      requiredFields: ["title", "body"],
      presentFields: ["title"],
      evidenceEnvelopeIds: ["raw-detail-a"],
    },
    comments: {
      access: "VISIBLE",
      platformDeclaredTotal: 1,
      capturedTopLevelIds: [],
      replyThreads: [],
      topLevelPaginationExhausted: false,
      nextCursor: "cursor-1",
      evidenceEnvelopeIds: ["raw-comments-a"],
    },
  });

  const reconstructed = new RankingWorkbench(new FileEvidenceStore(databasePath));
  const plan = await reconstructed.planEnrichment({
    planId: "enrichment-001",
    scopeId: rankingSnapshot.scopeId,
    policy: { maxTargets: 5, includeComments: true },
    createdAt: "2026-09-24T04:10:00.000Z",
  });

  assert.deepEqual(plan.tasks.map((task) => task.noteId), ["note-a"]);
  assert.deepEqual(plan.tasks[0].stages, ["DETAIL", "COMMENTS"]);
  const store = new FileEvidenceStore(databasePath);
  assert.equal((await store.getRankingLedger(rankingSnapshot.scopeId))?.snapshots.length, 1);
  assert.equal((await store.getCompletenessLedger("note-a"))?.observationCount, 1);
  assert.deepEqual(await store.getEnrichmentPlan("enrichment-001"), plan);
});
