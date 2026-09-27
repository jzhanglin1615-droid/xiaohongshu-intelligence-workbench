import assert from "node:assert/strict";
import test from "node:test";
import { RankingMonitor, completeRankingMonitorSchedule, reconcileRankingMonitorSchedule } from "../src/ranking-monitor.ts";

test("manual ranking refresh executes the configured snapshot runner and records a receipt", async () => {
  const scopes: string[] = [];
  const monitor = new RankingMonitor({ monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true }, {
    async capture(scopeId) { scopes.push(scopeId); return { snapshotId: "snapshot-001" }; },
  }, () => "2026-09-25T05:00:00.000Z");
  const receipt = await monitor.run("MANUAL");
  assert.deepEqual(scopes, ["discovery:daily"]);
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.snapshotId, "snapshot-001");
  assert.equal(receipt.browserTaskId, null);
  assert.equal(monitor.listReceipts().length, 1);
});

test("overlapping ranking captures are skipped instead of duplicating work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const monitor = new RankingMonitor({ monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true }, {
    async capture() { await gate; return { snapshotId: "snapshot-001" }; },
  });
  const first = monitor.run("SCHEDULED");
  const overlap = await monitor.run("MANUAL");
  assert.equal(overlap.status, "SKIPPED_OVERLAP");
  release();
  assert.equal((await first).status, "SUCCEEDED");
});

test("ranking monitor records runner failures and remains usable", async () => {
  let attempts = 0;
  const monitor = new RankingMonitor({ monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true }, {
    async capture() { attempts += 1; if (attempts === 1) throw new Error("SOURCE_UNAVAILABLE"); return { snapshotId: "snapshot-002" }; },
  });
  assert.equal((await monitor.run()).status, "FAILED");
  assert.equal((await monitor.run()).status, "SUCCEEDED");
});

test("scheduled monitoring can start and stop without keeping the process alive", () => {
  const monitor = new RankingMonitor({ monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true }, { async capture() { return { snapshotId: "unused" }; } });
  monitor.start();
  assert.equal(monitor.isRunning(), true);
  monitor.stop();
  assert.equal(monitor.isRunning(), false);
});

test("real adapter dispatch is recorded without pretending a snapshot already exists", async () => {
  const monitor = new RankingMonitor({ monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true }, {
    async capture() { return { kind: "BROWSER_TASK", browserTaskId: "browser-task-001" }; },
  });
  const receipt = await monitor.run("MANUAL");
  assert.equal(receipt.status, "DISPATCHED");
  assert.equal(receipt.snapshotId, null);
  assert.equal(receipt.browserTaskId, "browser-task-001");
});

test("persisted monitor receipts survive reconstruction and sequence numbers do not collide", async () => {
  const persisted = [{ runId: "daily:000042", monitorId: "daily", trigger: "SCHEDULED" as const, startedAt: "2026-09-25T04:00:00.000Z", finishedAt: "2026-09-25T04:00:01.000Z", status: "SUCCEEDED" as const, snapshotId: "snapshot-042", browserTaskId: null, errorCode: null }];
  const committed: string[] = [];
  const monitor = new RankingMonitor(
    { monitorId: "daily", scopeId: "discovery:daily", intervalMs: 60_000, enabled: true },
    { async capture() { return { snapshotId: "snapshot-043" }; } },
    () => "2026-09-25T05:00:00.000Z",
    { initialReceipts: persisted, async onReceipt(receipt) { committed.push(receipt.runId); } },
  );
  const receipt = await monitor.run("MANUAL");
  assert.equal(receipt.runId, "daily:000043");
  assert.deepEqual(committed, ["daily:000043"]);
  assert.deepEqual(monitor.listReceipts().map((item) => item.runId), ["daily:000042", "daily:000043"]);
});

test("schedule initialization persists the next due time without an immediate capture", () => {
  const result = reconcileRankingMonitorSchedule(
    { monitorId: "daily", scopeId: "ranking:daily", intervalMs: 60_000, enabled: true },
    null,
    "2026-09-25T05:00:00.000Z",
  );
  assert.equal(result.due, false);
  assert.equal(result.state.nextScheduledAt, "2026-09-25T05:01:00.000Z");
  assert.equal(result.state.pendingScheduledFor, null);
});

test("an overdue durable schedule requests one bounded catch-up and advances to a future cadence", () => {
  const result = reconcileRankingMonitorSchedule(
    { monitorId: "daily", scopeId: "ranking:daily", intervalMs: 60_000, enabled: true },
    { intervalMs: 60_000, nextScheduledAt: "2026-09-25T05:01:00.000Z", pendingScheduledFor: null, lastScheduledAt: null, lastCatchUpAt: null, missedIntervals: 0, updatedAt: "2026-09-25T05:00:00.000Z" },
    "2026-09-25T05:03:30.000Z",
  );
  assert.equal(result.due, true);
  assert.equal(result.scheduledFor, "2026-09-25T05:01:00.000Z");
  assert.equal(result.missedIntervals, 3);
  assert.equal(result.scheduleLagMs, 150_000);
  assert.equal(result.state.nextScheduledAt, "2026-09-25T05:04:00.000Z");
  assert.equal(result.state.pendingScheduledFor, "2026-09-25T05:01:00.000Z");
});

test("an interrupted scheduled capture remains pending after reconstruction until a receipt closes it", () => {
  const config = { monitorId: "daily", scopeId: "ranking:daily", intervalMs: 60_000, enabled: true };
  const pending = reconcileRankingMonitorSchedule(config, { intervalMs: 60_000, nextScheduledAt: "2026-09-25T05:01:00.000Z", pendingScheduledFor: null, lastScheduledAt: null, lastCatchUpAt: null, missedIntervals: 0, updatedAt: "2026-09-25T05:00:00.000Z" }, "2026-09-25T05:02:10.000Z").state;
  const recovered = reconcileRankingMonitorSchedule(config, pending, "2026-09-25T05:02:20.000Z");
  assert.equal(recovered.due, true);
  assert.equal(recovered.scheduledFor, "2026-09-25T05:01:00.000Z");
  const completed = completeRankingMonitorSchedule(recovered.state, recovered.scheduledFor!, "2026-09-25T05:02:21.000Z", true);
  assert.equal(completed.pendingScheduledFor, null);
  assert.equal(completed.lastScheduledAt, "2026-09-25T05:01:00.000Z");
  assert.equal(completed.lastCatchUpAt, "2026-09-25T05:02:21.000Z");
});

test("changing the interval resets cadence instead of replaying an incompatible schedule", () => {
  const result = reconcileRankingMonitorSchedule(
    { monitorId: "daily", scopeId: "ranking:daily", intervalMs: 120_000, enabled: true },
    { intervalMs: 60_000, nextScheduledAt: "2026-09-25T04:00:00.000Z", pendingScheduledFor: "2026-09-25T04:00:00.000Z", lastScheduledAt: null, lastCatchUpAt: null, missedIntervals: 1, updatedAt: "2026-09-25T04:00:00.000Z" },
    "2026-09-25T05:00:00.000Z",
  );
  assert.equal(result.due, false);
  assert.equal(result.state.nextScheduledAt, "2026-09-25T05:02:00.000Z");
  assert.equal(result.state.pendingScheduledFor, null);
});
