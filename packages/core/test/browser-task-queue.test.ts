import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTaskQueue } from "../src/browser-task-queue.ts";

const t0 = "2026-09-25T00:00:00.000Z";

test("browser tasks are priority leased and committed with evidence", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "low", sourceId: "ranking-1", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=a", expectedPageType: "SEARCH", priority: 10 }, t0);
  queue.enqueue({ taskId: "high", sourceId: "ranking-1", targetUrl: "https://www.xiaohongshu.com/explore/note-1", expectedPageType: "NOTE_DETAIL", priority: 90 }, t0);
  const leased = queue.leaseNext("extension-a", t0)!;
  assert.equal(leased.taskId, "high");
  const done = queue.complete(leased.taskId, leased.lease!.token, "browser-receipt-1", "2026-09-25T00:00:10.000Z");
  assert.equal(done.status, "SUCCEEDED");
  assert.equal(done.receiptId, "browser-receipt-1");
});

test("human verification blocks instead of silently completing", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "human", sourceId: "search-1", targetUrl: "https://www.xiaohongshu.com/explore/note-2", expectedPageType: "NOTE_DETAIL" }, t0);
  const leased = queue.leaseNext("extension-a", t0)!;
  const failed = queue.fail(leased.taskId, leased.lease!.token, { category: "NEEDS_HUMAN", code: "LOGIN_REQUIRED", message: "Login is required." }, "2026-09-25T00:00:20.000Z");
  assert.equal(failed.status, "BLOCKED");
  assert.equal(queue.leaseNext("extension-a", "2026-09-25T00:00:21.000Z"), null);
});

test("expired leases recover within attempt bounds and fail at the ceiling", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "recover", sourceId: "search-1", targetUrl: "https://www.xiaohongshu.com/explore/note-3", expectedPageType: "NOTE_DETAIL", maxAttempts: 2 }, t0);
  queue.leaseNext("extension-a", t0, 1000);
  assert.equal(queue.recoverExpired("2026-09-25T00:00:02.000Z")[0].status, "QUEUED");
  queue.leaseNext("extension-a", "2026-09-25T00:00:03.000Z", 1000);
  assert.equal(queue.recoverExpired("2026-09-25T00:00:05.000Z")[0].status, "FAILED");
});

test("persistent collection tasks survive expired leases and retryable failures until paused externally", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({
    taskId: "persistent",
    sourceId: "ranking-1",
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=persistent",
    expectedPageType: "SEARCH",
    maxAttempts: 1,
    context: { runKind: "RANKING", runId: "r-persistent", searchLimit: 100, persistentUntilPaused: true },
  }, t0);
  const first = queue.leaseNext("extension-a", t0, 1000)!;
  assert.equal(first.context?.searchLimit, 100);
  assert.equal(first.context?.persistentUntilPaused, true);
  assert.equal(queue.recoverExpired("2026-09-25T00:00:02.000Z")[0].status, "QUEUED");
  const second = queue.leaseNext("extension-a", "2026-09-25T00:00:03.000Z", 1000)!;
  const retried = queue.fail(second.taskId, second.lease!.token, { category: "RETRYABLE", code: "TEMPORARY_PAGE_STATE", message: "Try again after the page recovers." }, "2026-09-25T00:00:03.500Z");
  assert.equal(retried.status, "QUEUED");
  assert.equal(retried.attempts, 2);
});

test("queue rejects non-Xiaohongshu targets", () => {
  const queue = new BrowserTaskQueue();
  assert.throws(() => queue.enqueue({ sourceId: "bad", targetUrl: "https://example.com/", expectedPageType: "SEARCH" }, t0), /TARGET_NOT_ALLOWED/);
});

test("retry history is append-only and survives a later success", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "history", sourceId: "detail-1", targetUrl: "https://www.xiaohongshu.com/explore/history", expectedPageType: "NOTE_DETAIL", maxAttempts: 2 }, t0);
  const first = queue.leaseNext("extension-a", t0)!;
  const retry = queue.fail(first.taskId, first.lease!.token, { category: "RETRYABLE", code: "COMMENT_TRAVERSAL_INCOMPLETE", message: "Replies remain." }, "2026-09-25T00:00:10.000Z");
  assert.equal(retry.status, "QUEUED");
  const second = queue.leaseNext("extension-a", "2026-09-25T00:00:11.000Z")!;
  const done = queue.complete(second.taskId, second.lease!.token, "browser-receipt-final", "2026-09-25T00:00:12.000Z");
  assert.equal(done.status, "SUCCEEDED");
  assert.equal(done.error, undefined);
  assert.deepEqual(done.attemptHistory, [{ attempt: 1, at: "2026-09-25T00:00:10.000Z", category: "RETRYABLE", code: "COMMENT_TRAVERSAL_INCOMPLETE", message: "Replies remain." }]);
});

test("blocked work is terminal and does not suppress a later monitoring run", () => {
  const queue = new BrowserTaskQueue();
  const first = queue.enqueue({ taskId: "blocked-first", sourceId: "ranking-1", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=retry", expectedPageType: "SEARCH" }, t0);
  const leased = queue.leaseNext("extension-a", "2026-09-25T00:00:01.000Z")!;
  queue.fail(first.taskId, leased.lease!.token, { category: "NEEDS_HUMAN", code: "LOGIN_REQUIRED", message: "Human action required." }, "2026-09-25T00:00:02.000Z");
  const second = queue.enqueue({ taskId: "after-block", sourceId: "ranking-1", targetUrl: first.targetUrl, expectedPageType: "SEARCH" }, "2026-09-25T00:05:00.000Z");
  assert.equal(second.taskId, "after-block");
  assert.equal(second.status, "QUEUED");
});

test("cancelling a keyword run closes queued tasks without disturbing other work", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "run-task", sourceId: "keyword-run:r1", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=run", expectedPageType: "SEARCH", context: { runId: "r1", keyword: "run" } }, t0);
  queue.enqueue({ taskId: "other-task", sourceId: "ranking", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=other", expectedPageType: "SEARCH" }, t0);
  assert.equal(queue.cancelByRun("r1", "2026-09-25T00:00:10.000Z").length, 1);
  assert.equal(queue.list().find((task) => task.taskId === "run-task")?.status, "CANCELLED");
  assert.equal(queue.list().find((task) => task.taskId === "other-task")?.status, "QUEUED");
});

test("an unavailable note is recorded as skipped and never re-leased", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "missing-note", sourceId: "ranking-1", targetUrl: "https://www.xiaohongshu.com/explore/missing", expectedPageType: "NOTE_DETAIL", context: { runId: "r1", noteId: "missing", parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=x", navigationMode: "CLICK_SEARCH_CARD" } }, t0);
  const leased = queue.leaseNext("extension-a", t0)!;
  const skipped = queue.skip(leased.taskId, leased.lease!.token, { code: "NOTE_NOT_VISIBLE_IN_PARENT_SEARCH", message: "The note card is no longer visible in the source result." }, "2026-09-25T00:00:10.000Z");
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(skipped.context?.navigationMode, "CLICK_SEARCH_CARD");
  assert.equal(skipped.context?.parentSearchUrl, "https://www.xiaohongshu.com/search_result?keyword=x");
  assert.equal(queue.leaseNext("extension-a", "2026-09-25T00:00:11.000Z"), null);
});

test("reaching a run target closes only its queued searches and preserves other runs", () => {
  const queue = new BrowserTaskQueue();
  queue.enqueue({ taskId: "target-a", sourceId: "keyword-run:r1", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=a", expectedPageType: "SEARCH", context: { runId: "r1", searchLimit: 100 } }, t0);
  queue.enqueue({ taskId: "target-b", sourceId: "keyword-run:r1", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=b", expectedPageType: "SEARCH", context: { runId: "r1", searchLimit: 100 } }, t0);
  queue.enqueue({ taskId: "other", sourceId: "keyword-run:r2", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=c", expectedPageType: "SEARCH", context: { runId: "r2" } }, t0);
  const leased = queue.leaseNext("extension-a", t0)!;
  assert.equal(leased.taskId, "target-a");
  assert.equal(queue.setLeasedSearchLimit(leased.taskId, 17).context?.searchLimit, 17);
  assert.equal(queue.finishQueuedByRun("r1", "2026-09-25T00:00:10.000Z").length, 1);
  assert.equal(queue.list().find((task) => task.taskId === "target-b")?.error?.code, "QUOTA_REACHED");
  assert.equal(queue.list().find((task) => task.taskId === "other")?.status, "QUEUED");
});
