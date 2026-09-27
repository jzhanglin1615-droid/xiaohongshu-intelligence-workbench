import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  type NoteCompletenessLedger,
  type RankingLedger,
  type RankingSignal,
} from "../../contracts/src/index.ts";
import { buildEnrichmentPlan } from "../src/enrichment-planner.ts";

function signal(noteId: string, kind: RankingSignal["kind"], priorityScore: number, currentRank: number | null): RankingSignal {
  return {
    noteId,
    kind,
    previousRank: null,
    currentRank,
    rankDelta: null,
    consecutiveAppearances: 1,
    firstSeenAt: "2026-09-24T04:00:00.000Z",
    lastSeenAt: "2026-09-24T04:00:00.000Z",
    priorityScore,
  };
}

function ranking(signals: RankingSignal[]): RankingLedger {
  return {
    schemaVersion: CONTRACT_VERSION,
    scopeId: "ranking:discovery:daily",
    snapshots: [{
      schemaVersion: CONTRACT_VERSION,
      snapshotId: "ranking-001",
      scopeId: "ranking:discovery:daily",
      scopeLabel: "发现页日榜",
      coverage: "COMPLETE",
      expectedSlots: signals.filter((item) => item.currentRank !== null).length,
      entries: signals.filter((item) => item.currentRank !== null).map((item) => ({
        noteId: item.noteId,
        rank: item.currentRank!,
        sourceEnvelopeId: `raw-${item.noteId}`,
      })),
      observedAt: "2026-09-24T04:00:00.000Z",
    }],
    latestSignals: signals,
    updatedAt: "2026-09-24T04:00:00.000Z",
  };
}

function completeness(noteId: string, detailStatus: NoteCompletenessLedger["detail"]["status"], commentsStatus: NoteCompletenessLedger["comments"]["status"]): NoteCompletenessLedger {
  return {
    schemaVersion: CONTRACT_VERSION,
    noteId,
    detail: {
      status: detailStatus,
      requiredFields: ["title"],
      presentFields: detailStatus === "COMPLETE" ? ["title"] : [],
      missingFields: detailStatus === "COMPLETE" ? [] : ["title"],
      evidenceEnvelopeIds: [],
    },
    comments: {
      status: commentsStatus,
      platformDeclaredTotal: commentsStatus === "COMPLETE" ? 0 : null,
      capturedTopLevelIds: [],
      capturedReplyIds: [],
      capturedTopLevelCount: 0,
      capturedReplyCount: 0,
      capturedUniqueCount: 0,
      countGap: commentsStatus === "COMPLETE" ? 0 : null,
      topLevelPaginationExhausted: commentsStatus === "COMPLETE",
      unresolvedReplyThreads: 0,
      replyThreads: [],
      nextCursor: commentsStatus === "COMPLETE" ? null : "next",
      evidenceEnvelopeIds: [],
    },
    overallStatus: detailStatus === "COMPLETE" && commentsStatus === "COMPLETE" ? "COMPLETE" : "PARTIAL",
    observationCount: 1,
    updatedAt: "2026-09-24T04:05:00.000Z",
  };
}

test("enrichment planning prioritizes gaps and enforces the explicit target budget", () => {
  const plan = buildEnrichmentPlan({
    planId: "plan-001",
    rankingLedger: ranking([
      signal("rising", "RISING", 90, 1),
      signal("new", "NEW_ENTRY", 80, 2),
      signal("steady", "UNCHANGED", 30, 3),
    ]),
    completeness: [completeness("steady", "COMPLETE", "COMPLETE")],
    policy: { maxTargets: 1, includeComments: true },
    createdAt: "2026-09-24T04:10:00.000Z",
  });
  assert.deepEqual(plan.tasks.map((task) => task.noteId), ["rising"]);
  assert.deepEqual(plan.tasks[0].stages, ["DETAIL", "COMMENTS"]);
  assert.equal(plan.skippedDueToBudget, 1);
});

test("complete notes and unobserved ranking omissions do not create automatic tasks", () => {
  const plan = buildEnrichmentPlan({
    planId: "plan-002",
    rankingLedger: ranking([
      signal("complete", "UNCHANGED", 40, 1),
      signal("unknown", "NOT_OBSERVED", 0, null),
    ]),
    completeness: [completeness("complete", "COMPLETE", "COMPLETE")],
    policy: { maxTargets: 10, includeComments: true },
    createdAt: "2026-09-24T04:10:00.000Z",
  });
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.blockedTargets, []);
});

test("drifted or human-required notes are routed to blockedTargets, never the automatic queue", () => {
  const blocked = completeness("blocked", "DRIFTED", "HUMAN_REQUIRED");
  blocked.overallStatus = "BLOCKED";
  const plan = buildEnrichmentPlan({
    planId: "plan-003",
    rankingLedger: ranking([signal("blocked", "NEW_ENTRY", 90, 1)]),
    completeness: [blocked],
    policy: { maxTargets: 10, includeComments: true },
    createdAt: "2026-09-24T04:10:00.000Z",
  });
  assert.deepEqual(plan.tasks, []);
  assert.deepEqual(plan.blockedTargets, [{
    noteId: "blocked",
    reasons: ["DETAIL_DRIFTED", "COMMENTS_HUMAN_REQUIRED"],
    rankingSignal: "NEW_ENTRY",
  }]);
});
