import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCollectionFixtureDemo } from "../../../apps/fixture-runner/src/collection-demo.ts";
import {
  FileEvidenceStore,
  assessViralCandidates,
  createContentDecisionCards,
} from "../src/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

async function fixtureEvidence() {
  const output = await mkdtemp(path.join(os.tmpdir(), "xhs-viral-"));
  const demo = await runCollectionFixtureDemo(PROJECT_ROOT, output);
  const store = new FileEvidenceStore(demo.databasePath);
  const notes = await store.listNotes();
  const qualityDecisions = await store.listQuality();
  const completenessLedgers = await store.listCompletenessLedgers();
  const rankingLedger = await store.getRankingLedger("ranking:discovery:daily");
  assert.ok(rankingLedger);
  return { store, notes, qualityDecisions, completenessLedgers, rankingLedger };
}

test("viral assessment preserves raw metrics, sample baseline, evidence, and counterexamples", async () => {
  const evidence = await fixtureEvidence();
  const assessments = assessViralCandidates({ ...evidence, scopeId: evidence.rankingLedger.scopeId, assessedAt: "2026-09-25T03:00:00.000Z" });
  const leading = assessments.find((item) => item.noteId === "note-001");
  assert.equal(leading?.status, "ELIGIBLE");
  assert.equal(leading?.rawMetrics.likes, 123);
  assert.equal(leading?.baseline.likes.median, 90);
  assert.equal(leading?.sample.totalNotes, 3);
  assert.ok((leading?.evidenceEnvelopeIds.length ?? 0) >= 3);
  assert.deepEqual(leading?.counterexampleNoteIds, ["note-002", "note-003"]);
  assert.ok((leading?.score ?? 0) > 0);
});

test("quality or completeness gaps block scoring instead of fabricating confidence", async () => {
  const evidence = await fixtureEvidence();
  const assessments = assessViralCandidates({ ...evidence, scopeId: evidence.rankingLedger.scopeId, assessedAt: "2026-09-25T03:00:00.000Z" });
  const blocked = assessments.find((item) => item.noteId === "note-003");
  assert.equal(blocked?.status, "BLOCKED");
  assert.equal(blocked?.score, null);
  assert.equal(blocked?.scoreComponents, null);
  assert.ok(blocked?.limitations.some((item) => item.includes("质量阻断")));
  assert.ok(blocked?.limitations.some((item) => item.includes("采集完整度不足")));
});

test("sparse samples stay insufficient and decision cards preserve the direction gate", async () => {
  const evidence = await fixtureEvidence();
  const notes = evidence.notes.slice(0, 2);
  const assessments = assessViralCandidates({
    ...evidence,
    notes,
    qualityDecisions: evidence.qualityDecisions.filter((item) => notes.some((note) => note.noteId === item.entityId)),
    completenessLedgers: evidence.completenessLedgers.filter((item) => notes.some((note) => note.noteId === item.noteId)),
    scopeId: evidence.rankingLedger.scopeId,
    assessedAt: "2026-09-25T03:00:00.000Z",
  });
  assert.ok(assessments.every((item) => item.status === "INSUFFICIENT_EVIDENCE" && item.score === null));
  const cards = createContentDecisionCards(assessments, notes, "2026-09-25T03:00:00.000Z");
  assert.ok(cards.every((card) => card.status === "INSUFFICIENT_EVIDENCE" && card.requiresContentDirection));
  assert.deepEqual(cards[0].evidenceEnvelopeIds, assessments[0].evidenceEnvelopeIds);
  await evidence.store.saveViralAssessments(assessments);
  await evidence.store.saveContentDecisionCards(cards);
  assert.equal((await evidence.store.listViralAssessments(evidence.rankingLedger.scopeId)).length, 2);
  assert.equal((await evidence.store.listContentDecisionCards()).length, 2);
});
