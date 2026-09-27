import assert from "node:assert/strict";
import test from "node:test";
import type { TaskError } from "../../contracts/src/index.ts";
import { WorkbenchError } from "../src/errors.ts";
import {
  beginRetry,
  emptyRetryQueue,
  enqueueRetry,
  failRetry,
  recoverInterruptedRetries,
  resolveRetry,
  type RetryPolicy,
} from "../src/retry-queue.ts";

const policy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 };
const retryable: TaskError = {
  targetId: "note-002",
  category: "RETRYABLE",
  code: "TEMPORARY_READ_FAILURE",
  message: "Temporary read failure.",
  retryable: true,
};

test("retry queue enforces due time and resolves only the selected item", () => {
  let queue = enqueueRetry(null, "retry-task", retryable, policy, "2026-09-24T00:00:00.000Z");
  queue = enqueueRetry(queue, "retry-task", { ...retryable, targetId: "note-003" }, policy, "2026-09-24T00:00:00.000Z");
  assert.throws(
    () => beginRetry(queue, "note-002", "2026-09-24T00:00:00.500Z"),
    (error: unknown) => error instanceof WorkbenchError && error.code === "RETRY_NOT_READY",
  );
  queue = beginRetry(queue, "note-002", "2026-09-24T00:00:01.000Z");
  queue = resolveRetry(queue, "note-002", "2026-09-24T00:00:01.100Z");
  assert.equal(queue.items.find((item) => item.targetId === "note-002")?.state, "RESOLVED");
  assert.equal(queue.items.find((item) => item.targetId === "note-003")?.state, "QUEUED");
});

test("retry queue applies bounded exponential delay and exhausts the item", () => {
  let queue = enqueueRetry(null, "retry-task", retryable, policy, "2026-09-24T00:00:00.000Z");
  queue = beginRetry(queue, "note-002", "2026-09-24T00:00:01.000Z");
  queue = failRetry(queue, "note-002", retryable, policy, "2026-09-24T00:00:01.000Z");
  assert.equal(queue.items[0]?.nextAttemptAt, "2026-09-24T00:00:03.000Z");
  queue = beginRetry(queue, "note-002", "2026-09-24T00:00:03.000Z");
  queue = failRetry(queue, "note-002", retryable, policy, "2026-09-24T00:00:03.000Z");
  assert.equal(queue.items[0]?.state, "EXHAUSTED");
  assert.equal(queue.items[0]?.attempts, 2);
  assert.equal(queue.items[0]?.nextAttemptAt, null);
});

test("non-retryable failures cannot silently enter the retry queue", () => {
  assert.throws(
    () => enqueueRetry(
      emptyRetryQueue("retry-task", "2026-09-24T00:00:00.000Z"),
      "retry-task",
      { ...retryable, category: "PERMANENT", retryable: false },
      policy,
      "2026-09-24T00:00:00.000Z",
    ),
    (error: unknown) => error instanceof WorkbenchError && error.code === "NON_RETRYABLE_TARGET",
  );
});

test("an interrupted in-progress retry becomes recoverable after a local restart", () => {
  let queue = enqueueRetry(null, "retry-task", retryable, policy, "2026-09-24T00:00:00.000Z");
  queue = beginRetry(queue, "note-002", "2026-09-24T00:00:01.000Z");
  const recovered = recoverInterruptedRetries(queue, policy, "2026-09-24T00:10:00.000Z");
  assert.equal(recovered.items[0]?.state, "QUEUED");
  assert.equal(recovered.items[0]?.nextAttemptAt, "2026-09-24T00:10:00.000Z");
  assert.equal(recovered.items[0]?.attempts, 1);
});
