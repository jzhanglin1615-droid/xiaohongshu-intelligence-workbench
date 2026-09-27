import assert from "node:assert/strict";
import test from "node:test";

await import("./lease-recovery-controller.js");
const decide = globalThis.XhsLeaseRecoveryController.decide;
const now = Date.parse("2026-09-25T00:00:00.000Z");
const local = { taskId: "task-1", lease: { token: "lease-1", expiresAt: "2026-09-25T00:05:00.000Z" } };

test("a matching unexpired server lease survives extension restart", () => {
  const remote = { ...local, status: "LEASED" };
  assert.deepEqual(decide(local, remote, now), { action: "KEEP", reason: "LEASE_CONFIRMED", task: remote });
});

test("an expired lease is cleared before another task is claimed", () => {
  const remote = { ...local, status: "LEASED", lease: { ...local.lease, expiresAt: "2026-09-24T23:59:59.000Z" } };
  assert.deepEqual(decide(local, remote, now), { action: "CLEAR_AND_CLAIM", reason: "LEASE_EXPIRED" });
});

test("a requeued or completed remote task invalidates stale local state", () => {
  assert.equal(decide(local, { ...local, status: "QUEUED" }, now).action, "CLEAR_AND_CLAIM");
  assert.equal(decide(local, { ...local, status: "SUCCEEDED" }, now).action, "CLEAR_AND_CLAIM");
});

test("a lease token mismatch never reuses another client lease", () => {
  const remote = { ...local, status: "LEASED", lease: { ...local.lease, token: "lease-2" } };
  assert.deepEqual(decide(local, remote, now), { action: "CLEAR_AND_CLAIM", reason: "LEASE_TOKEN_MISMATCH" });
});
