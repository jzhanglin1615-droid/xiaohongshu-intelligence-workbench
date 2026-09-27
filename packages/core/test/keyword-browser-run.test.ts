import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordPlan, createDetailTasks, createExpansionTasks, createKeywordBrowserRun, reconcileKeywordBrowserRun, BrowserTaskQueue } from "../src/index.ts";

const now = "2026-09-25T00:00:00.000Z";
const plan = buildKeywordPlan({ planId: "p1", taskId: "t1", seedKeywords: ["孩子画画"], expansions: [{ parent: "孩子画画", children: ["儿童画画教程"] }], policy: { maxDepth: 2, maxKeywords: 10, maxChildrenPerKeyword: 5, noteDetailsPerKeyword: 5, maxEstimatedNoteDetails: 50, excludedTerms: [] }, createdAt: now });

test("metric completion covers all missing image metrics and quota does not cancel details", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { searchLimit: 30, notesPerKeyword: 1, autoCollectNotes: true, completeMetrics: true }, now, "metrics");
  const queue = new BrowserTaskQueue(); const search = queue.enqueue(tasks[0], now);
  const cards = ["a", "b"].map(noteId => ({ noteId, sourceUrl: `https://www.xiaohongshu.com/explore/${noteId}`, mediaType: "IMAGE", likes: 1 }));
  const details = createDetailTasks(run, search, [...cards, { ...cards[0], noteId: "complete", collects: 0, shares: 0 }, { ...cards[0], noteId: "video", mediaType: "VIDEO" }]);
  assert.equal(details.length, 2);
  assert.deepEqual(details[0].context?.stages, ["DETAIL"]);
  for (const task of details) queue.enqueue(task, now);
  queue.finishQueuedByRun(run.runId, now);
  assert.equal(queue.list().filter(task => task.expectedPageType === "NOTE_DETAIL" && task.status === "QUEUED").length, 2);
  run.keywords[0].detailTaskIds = details.map(task => task.taskId);
  assert.equal(createDetailTasks(run, search, cards).length, 0);
  run.counters.admittedCards = 30;
  const done = queue.list().map(task => ({ ...task, status: "SUCCEEDED" as const }));
  assert.equal(reconcileKeywordBrowserRun(run, done, now).status, "PARTIAL");
  run.metricGaps = { a: [], b: [] };
  assert.equal(reconcileKeywordBrowserRun(run, done, now).status, "SUCCEEDED");
});

test("expanded keywords also complete metrics even when legacy scope disabled their details", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { autoCollectNotes: true, completeMetrics: true }, now, "expanded-metrics");
  const search = new BrowserTaskQueue().enqueue(tasks[0], now);
  search.context!.collectNotes = false;
  assert.equal(createDetailTasks(run, search, [{ noteId: "a", sourceUrl: "https://www.xiaohongshu.com/explore/a", mediaType: "IMAGE" }]).length, 1);
});

test("keyword browser run dispatches selected keywords with operational timing context", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { searchScope: "ALL_EXPANDED", searchLimit: 1500, requestIntervalMs: 8000, slowNetworkMaxWaitMs: 300000 }, now, "run-1");
  assert.equal(tasks.length, 1); assert.equal(tasks[0].context?.keywordTotal, 1); assert.equal(tasks[0].context?.searchLimit, 1500); assert.equal(tasks[0].context?.requestIntervalMs, 8000); assert.equal(run.status, "QUEUED");
  const expanded = createExpansionTasks(run, { ...tasks[0], taskId: "search", status: "QUEUED", attempts: 0, createdAt: now, updatedAt: now, priority: 70, maxAttempts: 3 }, ["儿童画画教程", "儿童画画教程"]);
  assert.equal(expanded.length, 1); assert.equal(expanded[0].context?.collectNotes, false);
});

test("keyword browser run accepts the target saved from the browser overlay", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { searchLimit: 3000 }, now, "run-custom-target");
  assert.equal(run.settings.searchLimit, 3000);
  assert.equal(tasks[0].context?.searchLimit, 3000);
});

test("keyword collection defaults to search candidates without detail fan-out", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { searchLimit: 100 }, now, "run-search-only");
  const search = new BrowserTaskQueue().enqueue(tasks[0], now);
  const details = createDetailTasks(run, search, [
    { noteId: "n1", sourceUrl: "https://www.xiaohongshu.com/explore/n1", mediaType: "IMAGE" },
  ]);

  assert.equal(run.settings.autoCollectNotes, false);
  assert.equal(tasks[0].context?.collectNotes, false);
  assert.deepEqual(details, []);
});

test("search cards fan out into bounded detail tasks and reconcile the run", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { notesPerKeyword: 1, autoCollectNotes: true }, now, "run-2");
  const queue = new BrowserTaskQueue(); const search = queue.enqueue(tasks[0], now);
  const details = createDetailTasks(run, search, [{ noteId: "n1", sourceUrl: "https://www.xiaohongshu.com/explore/n1" }, { noteId: "n2", sourceUrl: "https://www.xiaohongshu.com/explore/n2" }]);
  assert.equal(details.length, 1);
  assert.equal(details[0].context?.noteId, "n1");
  assert.equal(details[0].context?.navigationMode, "CLICK_SEARCH_CARD");
  assert.equal(details[0].context?.parentSearchUrl, search.targetUrl);
  queue.enqueue(details[0], now);
  const updated = reconcileKeywordBrowserRun(run, queue.list(), now);
  assert.equal(updated.counters.total, 2); assert.equal(updated.counters.savedNotes, 0);
});

test("TOP_N detail tasks use visible engagement strength instead of DOM order", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { notesPerKeyword: 2, autoCollectNotes: true, collectionMethod: "TOP_N" }, now, "run-ranked");
  const search = new BrowserTaskQueue().enqueue(tasks[0], now);
  const details = createDetailTasks(run, search, [
    { noteId: "first", sourceUrl: "https://www.xiaohongshu.com/explore/first", likes: 2 },
    { noteId: "strong", sourceUrl: "https://www.xiaohongshu.com/explore/strong", likes: 100, collects: 20 },
    { noteId: "discussion", sourceUrl: "https://www.xiaohongshu.com/explore/discussion", likes: 20, comments: 50 },
  ]);
  assert.deepEqual(details.map((item) => item.context?.noteId), ["discussion", "strong"]);
});

test("video candidates stay in search results and never fan out into detail tasks", () => {
  const { run, tasks } = createKeywordBrowserRun(plan, { notesPerKeyword: 2, autoCollectNotes: true, collectionMethod: "TOP_N" }, now, "run-video-search-only");
  const search = new BrowserTaskQueue().enqueue(tasks[0], now);
  const details = createDetailTasks(run, search, [
    { noteId: "viral-video", sourceUrl: "https://www.xiaohongshu.com/explore/viral-video", likes: 100000, mediaType: "VIDEO" },
    { noteId: "image-note", sourceUrl: "https://www.xiaohongshu.com/explore/image-note", likes: 10, mediaType: "IMAGE" },
  ]);
  assert.deepEqual(details.map((item) => item.context?.noteId), ["image-note"]);
});
