import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type EnrichmentPlan } from "../../contracts/src/index.ts";
import {
  BrowserTaskQueue,
  createRankingBrowserRun,
  createRankingEnrichmentTasks,
  createRankingGapRefillTasks,
  reconcileRankingBrowserRun,
  updateRankingTargetGaps,
} from "../src/index.ts";

const now = "2026-09-25T02:00:00.000Z";
test("single-attempt validation propagates its retry limit to detail tasks", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "validation", scopeId: "validation", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=test", searchLimit: 5, completeMetrics: true, maxRefillRounds: 0 }, now);
  task.maxAttempts = 1;
  const search = new BrowserTaskQueue().enqueue(task, now);
  const details = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [] }, [
    { noteId: "validation-note", sourceUrl: "https://www.xiaohongshu.com/explore/validation-note", mediaType: "IMAGE", likes: 1 },
  ]);
  assert.equal(details.length, 1);
  assert.equal(details[0].maxAttempts, 1);
  assert.equal(run.settings.maxRefillRounds, 0);
});
test("metric mode covers cards outside the selective enrichment plan", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "m", scopeId: "s", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=a", searchLimit: 30, completeMetrics: true }, now);
  const search = new BrowserTaskQueue().enqueue(task, now);
  const details = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [] }, [
    { noteId: "outside-plan", sourceUrl: "https://www.xiaohongshu.com/explore/outside-plan", mediaType: "IMAGE", likes: 2 },
  ]);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].context?.stages, ["DETAIL"]);
});
const plan: EnrichmentPlan = {
  schemaVersion: CONTRACT_VERSION, planId: "ranking-enrichment-1", scopeId: "ranking:discovery:daily",
  tasks: [
    { targetId: "target-a", noteId: "note-a", priority: 95, stages: ["DETAIL", "COMMENTS"], reasons: ["NEW_ENTRY"], rankingSignal: "NEW_ENTRY", currentRank: 1 },
    { targetId: "target-b", noteId: "note-b", priority: 80, stages: ["DETAIL"], reasons: ["RISING"], rankingSignal: "RISING", currentRank: 2 },
  ],
  blockedTargets: [], skippedDueToBudget: 0, createdAt: now,
};

test("ranking browser run creates a persistent search task with bounded execution settings", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", searchLimit: 1500, maxDetailTargets: 12, requestIntervalMs: 9000, slowNetworkMaxWaitMs: 240000 }, now, "ranking-run-1");
  assert.equal(run.status, "QUEUED");
  assert.equal(run.settings.maxDetailTargets, 12);
  assert.equal(run.settings.searchLimit, 1500);
  assert.equal(task.context?.runKind, "RANKING");
  assert.equal(task.context?.runId, "ranking-run-1");
  assert.equal(task.context?.noteLimit, 12);
  assert.equal(task.context?.searchLimit, 1500);
  assert.equal(task.context?.persistentUntilPaused, true);
});

test("ranking browser run accepts a user-selected target above 1500", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", searchLimit: 3000 }, now, "ranking-run-custom-target");
  assert.equal(run.settings.searchLimit, 3000);
  assert.equal(task.context?.searchLimit, 3000);
});

test("ranking collection is discovery-only by default and never fans out into detail tasks", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", searchLimit: 100 }, now, "ranking-run-search-only");
  const search = new BrowserTaskQueue().enqueue(task, now);
  const details = createRankingEnrichmentTasks(run, search, plan, [
    { noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a", mediaType: "IMAGE" },
  ]);

  assert.equal(run.settings.maxDetailTargets, 0);
  assert.equal(task.context?.autoCollectNotes, false);
  assert.equal(task.context?.collectNotes, false);
  assert.deepEqual(details, []);
  assert.deepEqual(run.detailTargets, []);

  run.counters.discoveredCandidates = 100;
  run.counters.ingestedCandidates = 96;
  const reconciled = reconcileRankingBrowserRun(run, [search], "2026-09-25T02:00:01.000Z");
  assert.equal(reconciled.counters.discoveredCandidates, 100);
  assert.equal(reconciled.counters.ingestedCandidates, 96);
});

test("ranking enrichment plan drives bounded detail and comment tasks instead of becoming inert metadata", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 1 }, now, "ranking-run-2");
  const search = new BrowserTaskQueue().enqueue(task, now);
  const tasks = createRankingEnrichmentTasks(run, search, plan, [
    { noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" },
    { noteId: "note-b", sourceUrl: "https://www.xiaohongshu.com/explore/note-b" },
  ]);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].context?.stages, ["DETAIL", "COMMENTS"]);
  assert.equal(tasks[0].context?.planId, plan.planId);
  assert.equal(tasks[0].context?.noteId, "note-a");
  assert.equal(tasks[0].context?.navigationMode, "CLICK_SEARCH_CARD");
  assert.equal(tasks[0].context?.parentSearchUrl, search.targetUrl);
  assert.deepEqual(run.dispatchGaps, [{ noteId: "note-b", code: "TARGET_SKIPPED_BY_RUN_BUDGET" }]);
  assert.equal(createRankingEnrichmentTasks(run, search, plan, []).length, 0);
});

test("ranking discovery records video candidates without dispatching video detail tasks", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 2 }, now, "ranking-run-video-search-only");
  const search = new BrowserTaskQueue().enqueue(task, now);
  const tasks = createRankingEnrichmentTasks(run, search, plan, [
    { noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a", mediaType: "VIDEO" },
    { noteId: "note-b", sourceUrl: "https://www.xiaohongshu.com/explore/note-b", mediaType: "IMAGE" },
  ]);
  assert.deepEqual(tasks.map((item) => item.context?.noteId), ["note-b"]);
  assert.deepEqual(run.dispatchGaps, []);
});

test("a disappeared ranking note makes the completed run partial instead of failing the batch", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 1 }, now, "ranking-run-skipped");
  const queue = new BrowserTaskQueue();
  const searchInput = queue.enqueue(task, now);
  const search = queue.complete(searchInput.taskId, queue.leaseNext("extension-a", now)!.lease!.token, "search-receipt", "2026-09-25T02:00:01.000Z");
  const [detailInput] = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [plan.tasks[0]] }, [{ noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" }]);
  queue.enqueue(detailInput, now);
  const detail = queue.leaseNext("extension-a", "2026-09-25T02:00:02.000Z")!;
  queue.skip(detail.taskId, detail.lease!.token, { code: "NOTE_NOT_VISIBLE_IN_PARENT_SEARCH", message: "Gone." }, "2026-09-25T02:00:03.000Z");
  const reconciled = reconcileRankingBrowserRun(run, queue.list(), "2026-09-25T02:00:04.000Z");
  assert.equal(reconciled.status, "PARTIAL");
  assert.equal(reconciled.counters.skipped, 1);
  assert.equal(reconciled.counters.savedNotes, 0);
});

test("ranking run reports PARTIAL when tasks finish but evidence gaps remain", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 2 }, now, "ranking-run-3");
  const queue = new BrowserTaskQueue();
  const search = queue.enqueue(task, now);
  const [detail] = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [plan.tasks[0]] }, [{ noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" }]);
  queue.enqueue(detail, now);
  const finished = queue.list().map((item) => ({ ...item, status: "SUCCEEDED" as const, receiptId: `receipt-${item.taskId}` }));
  run.detailTargets[0].unresolvedGaps = ["COMMENT_PLATFORM_IDS_NOT_OBSERVABLE"];
  const reconciled = reconcileRankingBrowserRun(run, finished, "2026-09-25T02:01:00.000Z");
  assert.equal(reconciled.status, "PARTIAL");
  assert.equal(reconciled.counters.savedNotes, 1);
  assert.equal(reconciled.counters.unresolvedGaps, 1);
});

test("ranking gaps are classified and only refillable evidence gaps create a bounded refill task", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 1, maxRefillRounds: 2 }, now, "ranking-run-refill-1");
  const queue = new BrowserTaskQueue();
  const search = queue.enqueue(task, now);
  const [detailInput] = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [plan.tasks[0]] }, [{ noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" }]);
  const detail = queue.enqueue(detailInput, now);

  const records = updateRankingTargetGaps(run, "note-a", ["DETAIL_BODY_MISSING", "COMMENT_PLATFORM_IDS_NOT_OBSERVABLE"], detail.taskId, "2026-09-25T02:01:00.000Z");
  assert.deepEqual(records.map(({ code, disposition, status }) => ({ code, disposition, status })), [
    { code: "COMMENT_PLATFORM_IDS_NOT_OBSERVABLE", disposition: "BLOCKED_UNOBSERVABLE", status: "BLOCKED" },
    { code: "DETAIL_BODY_MISSING", disposition: "REFILLABLE", status: "OPEN" },
  ]);

  const [refillInput] = createRankingGapRefillTasks(run, detail, "2026-09-25T02:01:01.000Z");
  assert.equal(refillInput.context?.runKind, "GAP_REFILL");
  assert.deepEqual(refillInput.context?.stages, ["DETAIL"]);
  assert.equal(run.gapRecords.find((item) => item.code === "DETAIL_BODY_MISSING")?.attempts, 1);
  assert.equal(run.gapRecords.find((item) => item.code === "DETAIL_BODY_MISSING")?.status, "REFILL_QUEUED");
  assert.equal(run.gapRecords.find((item) => item.code === "COMMENT_PLATFORM_IDS_NOT_OBSERVABLE")?.refillTaskIds.length, 0);
});

test("ranking refill exhausts exactly at its configured round budget and never loops forever", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 1, maxRefillRounds: 2 }, now, "ranking-run-refill-2");
  const queue = new BrowserTaskQueue();
  const search = queue.enqueue(task, now);
  const [detailInput] = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [plan.tasks[0]] }, [{ noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" }]);
  let source = queue.enqueue(detailInput, now);

  updateRankingTargetGaps(run, "note-a", ["DETAIL_BODY_MISSING"], source.taskId, "2026-09-25T02:01:00.000Z");
  [source] = createRankingGapRefillTasks(run, source, "2026-09-25T02:01:01.000Z").map((input) => queue.enqueue(input, "2026-09-25T02:01:01.000Z"));
  updateRankingTargetGaps(run, "note-a", ["DETAIL_BODY_MISSING"], source.taskId, "2026-09-25T02:02:00.000Z");
  [source] = createRankingGapRefillTasks(run, source, "2026-09-25T02:02:01.000Z").map((input) => queue.enqueue(input, "2026-09-25T02:02:01.000Z"));
  updateRankingTargetGaps(run, "note-a", ["DETAIL_BODY_MISSING"], source.taskId, "2026-09-25T02:03:00.000Z");

  assert.equal(createRankingGapRefillTasks(run, source, "2026-09-25T02:03:01.000Z").length, 0);
  const gap = run.gapRecords.find((item) => item.code === "DETAIL_BODY_MISSING");
  assert.equal(gap?.attempts, 2);
  assert.equal(gap?.status, "EXHAUSTED");
  assert.equal(gap?.refillTaskIds.length, 2);
});

test("ranking refill resolution clears the gap and successful refill tasks do not inflate saved-note counts", () => {
  const { run, task } = createRankingBrowserRun({ monitorId: "daily", scopeId: plan.scopeId, targetUrl: "https://www.xiaohongshu.com/search_result?keyword=coffee", maxDetailTargets: 1 }, now, "ranking-run-refill-3");
  const queue = new BrowserTaskQueue();
  const search = queue.enqueue(task, now);
  const [detailInput] = createRankingEnrichmentTasks(run, search, { ...plan, tasks: [plan.tasks[0]] }, [{ noteId: "note-a", sourceUrl: "https://www.xiaohongshu.com/explore/note-a" }]);
  const detail = queue.enqueue(detailInput, now);
  updateRankingTargetGaps(run, "note-a", ["DETAIL_BODY_MISSING"], detail.taskId, "2026-09-25T02:01:00.000Z");
  const [refillInput] = createRankingGapRefillTasks(run, detail, "2026-09-25T02:01:01.000Z");
  const refill = queue.enqueue(refillInput, "2026-09-25T02:01:01.000Z");
  updateRankingTargetGaps(run, "note-a", [], refill.taskId, "2026-09-25T02:02:00.000Z");
  const finished = queue.list().map((item) => ({ ...item, status: "SUCCEEDED" as const, receiptId: `receipt-${item.taskId}` }));
  const reconciled = reconcileRankingBrowserRun(run, finished, "2026-09-25T02:02:01.000Z");

  assert.equal(run.gapRecords[0].status, "RESOLVED");
  assert.equal(reconciled.status, "SUCCEEDED");
  assert.equal(reconciled.counters.savedNotes, 1);
  assert.equal(reconciled.counters.refillTasks, 1);
  assert.equal(reconciled.counters.unresolvedGaps, 0);
});
