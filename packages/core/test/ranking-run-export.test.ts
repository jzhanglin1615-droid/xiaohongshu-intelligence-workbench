import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCaptureTask } from "../src/browser-task-queue.ts";
import type { RankingBrowserRun } from "../src/ranking-browser-run.ts";
import { createRankingRunAuditBundle, verifyRankingRunAuditBundle } from "../src/ranking-run-export.ts";

const now = "2026-09-25T10:00:00.000Z";

function sampleRun(): RankingBrowserRun {
  return {
    runId: "ranking-run-audit",
    monitorId: "daily",
    scopeId: "ranking:daily",
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=AI&xsec_token=secret-xsec",
    status: "PARTIAL",
    searchTaskId: "search-1",
    enrichmentPlanIds: ["plan-1"],
    detailTargets: [{ noteId: "note-1", taskId: "detail-1", priority: 90, stages: ["DETAIL", "COMMENTS"], unresolvedGaps: ["DETAIL_BODY_MISSING"] }],
    dispatchGaps: [{ noteId: "note-2", code: "TARGET_URL_MISSING" }],
    gapRecords: [{ noteId: "note-1", code: "DETAIL_BODY_MISSING", disposition: "REFILLABLE", status: "REFILL_QUEUED", attempts: 1, maxAttempts: 2, sourceTaskId: "detail-1", refillTaskIds: ["refill-1"], firstSeenAt: now, updatedAt: now }],
    settings: { maxDetailTargets: 20, maxRefillRounds: 2, requestIntervalMs: 8000, slowNetworkMaxWaitMs: 300000 },
    counters: { total: 3, succeeded: 1, unresolvedGaps: 2 },
    createdAt: now,
    updatedAt: now,
  };
}

function sampleTasks(): BrowserCaptureTask[] {
  return [
    {
      taskId: "search-1", sourceId: "ranking-monitor:daily", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=AI&xsec_token=secret-task", expectedPageType: "SEARCH", priority: 100,
      status: "SUCCEEDED", attempts: 1, maxAttempts: 3, createdAt: now, updatedAt: now, receiptId: "receipt-search", attemptHistory: [], context: { runKind: "RANKING", runId: "ranking-run-audit" },
    },
    {
      taskId: "detail-1", sourceId: "ranking-run:ranking-run-audit", targetUrl: "https://www.xiaohongshu.com/explore/note-1?signature=secret-signature&source=ranking", expectedPageType: "NOTE_DETAIL", priority: 90,
      status: "LEASED", attempts: 2, maxAttempts: 3, createdAt: now, updatedAt: now, lease: { clientId: "extension-1", token: "lease-secret", expiresAt: "2026-09-25T10:02:00.000Z" },
      error: { category: "RETRYABLE", code: "COMMENT_TRAVERSAL_INCOMPLETE", message: "reply page incomplete" },
      attemptHistory: [{ attempt: 1, at: now, category: "RETRYABLE", code: "COMMENT_TRAVERSAL_INCOMPLETE", message: "reply page incomplete" }],
      context: { runKind: "RANKING", runId: "ranking-run-audit", noteId: "note-1", stages: ["DETAIL", "COMMENTS"] },
    },
    {
      taskId: "other-run", sourceId: "other", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=other", expectedPageType: "SEARCH", priority: 1,
      status: "QUEUED", attempts: 0, maxAttempts: 3, createdAt: now, updatedAt: now, attemptHistory: [], context: { runKind: "RANKING", runId: "ranking-run-other" },
    },
  ];
}

test("ranking audit bundle preserves lifecycle evidence, isolates the run and removes secrets", () => {
  const bundle = createRankingRunAuditBundle(sampleRun(), sampleTasks(), now);
  const serialized = JSON.stringify(bundle);
  const detailTask = bundle.payload.tasks.find((task) => task.taskId === "detail-1")!;
  assert.equal(bundle.payload.tasks.length, 2);
  assert.equal(bundle.payload.evidenceReferences.length, 1);
  assert.equal(bundle.payload.summary.unresolvedGapCount, 2);
  assert.equal(detailTask.attemptHistory?.[0].code, "COMMENT_TRAVERSAL_INCOMPLETE");
  assert.equal(detailTask.lease?.clientId, "extension-1");
  assert.match(bundle.payload.run.targetUrl, /keyword=AI/);
  assert.match(detailTask.targetUrl, /source=ranking/);
  assert.doesNotMatch(serialized, /secret-xsec|secret-task|secret-signature|lease-secret|other-run/);
  assert.equal(verifyRankingRunAuditBundle(bundle), true);
});

test("ranking audit verification rejects payload mutation", () => {
  const bundle = createRankingRunAuditBundle(sampleRun(), sampleTasks(), now);
  bundle.payload.run.status = "SUCCEEDED";
  assert.equal(verifyRankingRunAuditBundle(bundle), false);
});
