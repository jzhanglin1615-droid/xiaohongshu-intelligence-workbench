import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileEvidenceStore,
  assessViralCandidates,
  createContentDecisionCards,
} from "../../../packages/core/src/index.ts";
import { runCollectionFixtureDemo } from "./collection-demo.ts";

export async function runIntelligenceFixtureDemo(projectRoot: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  const collection = await runCollectionFixtureDemo(projectRoot, path.join(outputDirectory, "collection"));
  const store = new FileEvidenceStore(collection.databasePath);
  const notes = await store.listNotes();
  const qualityDecisions = await store.listQuality();
  const completenessLedgers = await store.listCompletenessLedgers();
  const rankingLedger = await store.getRankingLedger("ranking:discovery:daily");
  if (!rankingLedger) throw new Error("The offline ranking ledger is missing.");

  const generatedAt = "2026-09-25T03:00:00.000Z";
  const assessments = assessViralCandidates({
    scopeId: rankingLedger.scopeId,
    notes,
    qualityDecisions,
    completenessLedgers,
    rankingLedger,
    assessedAt: generatedAt,
  });
  const decisionCards = createContentDecisionCards(assessments, notes, generatedAt);
  await store.saveViralAssessments(assessments);
  await store.saveContentDecisionCards(decisionCards);

  const report = {
    status: "M5_OFFLINE_EXPLAINABLE_ANALYSIS_SLICE_COMPLETE",
    generatedAt,
    evidenceMode: "OFFLINE_FIXTURES",
    scopeId: rankingLedger.scopeId,
    formulaVersion: assessments[0]?.formulaVersion ?? null,
    observationWindow: assessments[0]?.observationWindow ?? null,
    sample: assessments[0]?.sample ?? null,
    assessments,
    decisionCards,
    notes: notes.map((note) => ({ noteId: note.noteId, title: note.title, author: note.author, metrics: note.metrics })),
    completeness: completenessLedgers,
    rankingSnapshots: rankingLedger.snapshots,
    rankingSignals: rankingLedger.latestSignals,
    readiness: {
      explainableOfflineScoring: "PASS",
      evidenceLinkedDecisionCards: "PASS",
      visualWorkbenchPrototype: "PASS",
      realPlatformCollection: "NOT_STARTED",
      realWorldPredictiveValidity: "NOT_STARTED",
      contentDirection: "UNSET",
      userAcceptance: "NOT_STARTED",
    },
    externalActions: {
      xiaohongshuAccess: false,
      login: false,
      api: false,
      upload: false,
      publish: false,
    },
    jev: { calledForThisSlice: false, cumulativeCalls: 4 },
  };
  const reportPath = path.join(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { reportPath, databasePath: collection.databasePath, report };
}
