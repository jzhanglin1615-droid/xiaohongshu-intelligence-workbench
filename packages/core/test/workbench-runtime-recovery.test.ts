import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTaskQueue } from "../src/browser-task-queue.ts";
import { createRankingBrowserRun } from "../src/ranking-browser-run.ts";
import { recoverWorkbenchRuntime } from "../src/workbench-runtime-recovery.ts";

const t0 = "2026-09-25T00:00:00.000Z";

function leasedRankingRuntime(leaseMs: number) {
  const created = createRankingBrowserRun({ monitorId: "daily", scopeId: "ranking:daily", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=recovery" }, t0, "ranking-recovery");
  created.run.status = "RUNNING";
  const queue = new BrowserTaskQueue();
  queue.enqueue(created.task, t0);
  queue.leaseNext("extension-a", t0, leaseMs);
  return { schemaVersion: "1.0.0", browserTasks: queue.list(), rankingRuns: [created.run], keywordRuns: [] };
}

test("startup recovery requeues expired browser leases and reconciles their ranking run", () => {
  const result = recoverWorkbenchRuntime(leasedRankingRuntime(1_000), "2026-09-25T00:00:02.000Z", "recovery-expired");
  assert.equal(result.runtime.browserTasks?.[0].status, "QUEUED");
  assert.equal(result.runtime.browserTasks?.[0].error?.code, "BROWSER_LEASE_EXPIRED");
  assert.equal(result.runtime.rankingRuns?.[0].status, "QUEUED");
  assert.equal(result.receipt.status, "RECOVERED");
  assert.deepEqual(result.receipt.recoveredTaskIds, ["ranking-recovery-search"]);
  assert.deepEqual(result.receipt.runTransitions, [{ runKind: "RANKING", runId: "ranking-recovery", from: "RUNNING", to: "QUEUED" }]);
  assert.equal(result.runtime.startupRecoveryHistory?.[0].recoveryId, "recovery-expired");
});

test("startup recovery preserves a still-valid browser lease", () => {
  const result = recoverWorkbenchRuntime(leasedRankingRuntime(60_000), "2026-09-25T00:00:02.000Z", "recovery-active");
  assert.equal(result.runtime.browserTasks?.[0].status, "LEASED");
  assert.equal(result.runtime.rankingRuns?.[0].status, "RUNNING");
  assert.equal(result.receipt.status, "NO_CHANGES");
  assert.deepEqual(result.receipt.recoveredTaskIds, []);
  assert.deepEqual(result.receipt.preservedActiveLeaseTaskIds, ["ranking-recovery-search"]);
});

test("startup recovery never revives a cancelled run", () => {
  const runtime = leasedRankingRuntime(60_000);
  runtime.rankingRuns[0].status = "CANCELLED";
  runtime.browserTasks[0].status = "CANCELLED";
  runtime.browserTasks[0].lease = undefined;
  const result = recoverWorkbenchRuntime(runtime, "2026-09-25T00:00:02.000Z", "recovery-cancelled");
  assert.equal(result.runtime.rankingRuns?.[0].status, "CANCELLED");
  assert.equal(result.receipt.status, "NO_CHANGES");
  assert.deepEqual(result.receipt.runTransitions, []);
});

test("startup recovery repairs a stale queued run whose tasks are all cancelled", () => {
  const runtime = leasedRankingRuntime(60_000);
  runtime.rankingRuns[0].status = "QUEUED";
  runtime.browserTasks[0].status = "CANCELLED";
  runtime.browserTasks[0].lease = undefined;
  const result = recoverWorkbenchRuntime(runtime, "2026-09-25T00:00:02.000Z", "recovery-stale-queued");
  assert.equal(result.runtime.rankingRuns?.[0].status, "CANCELLED");
  assert.equal(result.receipt.status, "RECOVERED");
  assert.deepEqual(result.receipt.runTransitions, [{ runKind: "RANKING", runId: "ranking-recovery", from: "QUEUED", to: "CANCELLED" }]);
});
