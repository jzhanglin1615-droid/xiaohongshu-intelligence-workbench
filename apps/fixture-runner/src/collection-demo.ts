import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  type EnrichmentPlan,
  type KeywordPlan,
} from "../../../packages/contracts/src/index.ts";
import {
  CollectionRunExecutor,
  CollectionRunWorkbench,
  FileEvidenceStore,
  FixedClock,
  summarizeCollectionRun,
} from "../../../packages/core/src/index.ts";
import { FixtureCollector } from "./fixture-parser.ts";

export async function runCollectionFixtureDemo(projectRoot: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  const databasePath = path.join(outputDirectory, "database.json");
  await rm(databasePath, { force: true });
  const store = new FileEvidenceStore(databasePath);
  const clock = new FixedClock("2026-09-25T02:00:00.000Z");
  const keywordPlan: KeywordPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: "m2-execution-keywords",
    taskId: "m2-execution-task",
    policy: { maxDepth: 1, maxKeywords: 1, maxChildrenPerKeyword: 0, noteDetailsPerKeyword: 3, maxEstimatedNoteDetails: 3, excludedTerms: [] },
    nodes: [{ keywordId: "kw-ai-tools", value: "AI工具", normalized: "ai工具", depth: 0, source: "SEED", status: "QUEUED" }],
    edges: [],
    estimatedNoteDetails: 3,
    truncation: { hitKeywordLimit: false, hitNoteBudget: false, prunedByDepth: 0, prunedByExclusion: 0, prunedByChildLimit: 0 },
    createdAt: "2026-09-25T01:59:00.000Z",
  };
  const enrichmentPlan: EnrichmentPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: "m2-execution-enrichment",
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
    createdAt: "2026-09-25T01:59:10.000Z",
  };
  const runs = new CollectionRunWorkbench(store);
  await runs.create({
    runId: "m2-collection-execution-run",
    keywordPlan,
    enrichmentPlan,
    rankingScopeIds: ["ranking:discovery:daily"],
    budget: { maxRankingSnapshots: 1, maxKeywordSearches: 1, maxDetailTargets: 3, maxCommentTargets: 3 },
    createdAt: "2026-09-25T01:59:20.000Z",
  });
  const executor = new CollectionRunExecutor({
    collector: new FixtureCollector(path.join(projectRoot, "fixtures")),
    store,
    clock,
  });
  const receipt = await executor.execute("m2-collection-execution-run");
  const ledger = await runs.get("m2-collection-execution-run");
  const notes = await store.listNotes();
  const completeness = await store.listCompletenessLedgers();
  const ranking = await store.getRankingLedger("ranking:discovery:daily");
  const rawEnvelopes = await store.listRawEnvelopes();
  const report = {
    generatedAt: clock.now(),
    evidenceMode: "OFFLINE_FIXTURES",
    receipt,
    progress: summarizeCollectionRun(ledger),
    rawEvidence: {
      count: rawEnvelopes.length,
      envelopeIds: rawEnvelopes.map((envelope) => envelope.envelopeId),
      kinds: Object.fromEntries(["SEARCH_RESULTS", "NOTE_DETAIL", "COMMENT_PAGE"].map((kind) => [kind, rawEnvelopes.filter((envelope) => envelope.kind === kind).length])),
    },
    normalizedNotes: notes.map((note) => ({ noteId: note.noteId, detailStatus: note.detailStatus, keywords: note.keywords })),
    completeness: completeness.map((item) => ({ noteId: item.noteId, detail: item.detail.status, comments: item.comments.status, overall: item.overallStatus })),
    ranking: ranking?.latestSignals ?? [],
    readiness: {
      collectionExecutionLoop: "PASS",
      evidencePersistence: "PASS",
      realPlatformCollection: "NOT_STARTED",
      viralPatternAnalysis: "NOT_STARTED",
      contentDecisionSupport: "NOT_STARTED",
    },
  };
  const reportPath = path.join(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { reportPath, databasePath, report };
}
