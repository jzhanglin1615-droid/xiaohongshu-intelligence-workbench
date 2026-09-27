import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshCoordinator, pendingRefreshFeedback } from "./refresh-coordinator.js";

test("100 concurrent sync callers share one operation; failure releases the lock", async () => {
  const coordinator = createRefreshCoordinator();
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 100 }, () => coordinator.single("sync", async () => ++calls)));
  assert.equal(calls, 1);
  assert.ok(results.every(result => result === 1));
  await assert.rejects(coordinator.single("sync", () => { throw new Error("offline"); }));
  assert.equal(await coordinator.single("sync", () => ++calls), 2);
});
test("slow polling cannot overlap and idle polling is bounded", async () => {
  let now = 0; let calls = 0; let release;
  const coordinator = createRefreshCoordinator({ now: () => now });
  const work = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const a = coordinator.poll(work); const b = coordinator.poll(work);
  await Promise.resolve();
  assert.equal(calls, 1); release(); await Promise.all([a, b]);
  now = 9999; assert.equal(await coordinator.poll(work), false);
  now = 10000; await coordinator.poll(() => { calls++; });
  assert.equal(calls, 2);
});
test("hidden tabs do not poll; failure backoff does not block explicit sync", async () => {
  let now = 0; let calls = 0;
  const coordinator = createRefreshCoordinator({ now: () => now });
  const fail = () => { calls++; throw new Error("offline"); };
  await coordinator.poll(fail, { hidden: true }); assert.equal(calls, 0);
  await assert.rejects(coordinator.poll(fail));
  now = 3999; assert.equal(await coordinator.poll(fail), false);
  assert.equal(await coordinator.single("sync", () => "manual"), "manual");
  now = 4000; await coordinator.poll(() => {}, { active: true });
  now = 6000; assert.equal(await coordinator.poll(() => {}, { active: true }), true);
});
test("changed data and 90 second timeout never imply completion", () => {
  const pending = { baseline: "old", startedAt: 0 };
  assert.equal(pendingRefreshFeedback(pending, "new", 100000).done, false);
  const result = pendingRefreshFeedback(pending, "old", 100000);
  assert.equal(result.done, false); assert.match(result.message, /未收到完成确认/);
});
test("both exact target runs must finish; unrelated successes cannot complete them", () => {
  const pending = { baseline: "old", startedAt: 0, targets: [{ taskId: "task1" }, { runId: "direction1" }] };
  const runtime = { rankingDispatchHistory: [{ browserTaskId: "task1", rankingRunId: "rank1" }], rankingRuns: [{ runId: "rank1", status: "SUCCEEDED" }], keywordRuns: [{ runId: "other", status: "SUCCEEDED" }, { runId: "direction1", status: "RUNNING" }] };
  assert.equal(pendingRefreshFeedback(pending, "new", 10, runtime).done, false);
  runtime.keywordRuns[1].status = "SUCCEEDED";
  assert.equal(pendingRefreshFeedback(pending, "new", 10, runtime).tone, "success");
  runtime.keywordRuns[1].status = "PARTIAL";
  assert.equal(pendingRefreshFeedback(pending, "new", 10, runtime).tone, "error");
  runtime.keywordRuns[1].status = "PAUSED";
  assert.equal(pendingRefreshFeedback(pending, "new", 10, runtime).done, false);
});
