import {
  CONTRACT_VERSION,
  assertContract,
  type RetryQueueItem,
  type RetryQueueSnapshot,
  type TaskError,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "./errors.ts";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

function clone(snapshot: RetryQueueSnapshot): RetryQueueSnapshot {
  return structuredClone(snapshot);
}

function dueAt(now: string, attempts: number, policy: RetryPolicy): string {
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** attempts));
  return new Date(Date.parse(now) + delay).toISOString();
}

function validatePolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) {
    throw new Error("RetryPolicy.maxAttempts must be an integer between 1 and 10.");
  }
  if (!Number.isInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new Error("RetryPolicy.baseDelayMs must be a non-negative integer.");
  }
  if (!Number.isInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("RetryPolicy.maxDelayMs must be an integer greater than or equal to baseDelayMs.");
  }
}

function assertSnapshot(snapshot: RetryQueueSnapshot): RetryQueueSnapshot {
  assertContract<RetryQueueSnapshot>("RetryQueueSnapshot", snapshot);
  return snapshot;
}

export function emptyRetryQueue(taskId: string, now: string): RetryQueueSnapshot {
  return assertSnapshot({
    schemaVersion: CONTRACT_VERSION,
    taskId,
    items: [],
    updatedAt: now,
  });
}

export function enqueueRetry(
  current: RetryQueueSnapshot | null,
  taskId: string,
  failure: TaskError,
  policy: RetryPolicy,
  now: string,
): RetryQueueSnapshot {
  validatePolicy(policy);
  if (failure.category !== "RETRYABLE" || !failure.retryable) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "NON_RETRYABLE_TARGET",
      message: `Only RETRYABLE failures can enter the retry queue: ${failure.targetId}`,
      targetId: failure.targetId,
      retryable: false,
    });
  }
  const next = current ? clone(current) : emptyRetryQueue(taskId, now);
  if (next.taskId !== taskId) throw new Error(`Retry queue belongs to ${next.taskId}, not ${taskId}.`);
  const index = next.items.findIndex((item) => item.targetId === failure.targetId);
  const existing = index >= 0 ? next.items[index] : null;
  const attempts = existing && !["RESOLVED", "EXHAUSTED", "BLOCKED"].includes(existing.state)
    ? existing.attempts
    : 0;
  const item: RetryQueueItem = {
    targetId: failure.targetId,
    state: "QUEUED",
    attempts,
    maxAttempts: policy.maxAttempts,
    nextAttemptAt: dueAt(now, attempts, policy),
    lastError: failure,
  };
  if (index >= 0) next.items[index] = item;
  else next.items.push(item);
  next.items.sort((a, b) => a.targetId.localeCompare(b.targetId));
  next.updatedAt = now;
  return assertSnapshot(next);
}

export function beginRetry(
  current: RetryQueueSnapshot,
  targetId: string,
  now: string,
): RetryQueueSnapshot {
  const next = clone(current);
  const item = next.items.find((candidate) => candidate.targetId === targetId);
  if (!item) throw new Error(`Retry target is not queued: ${targetId}`);
  if (item.state !== "QUEUED") throw new Error(`Retry target ${targetId} is ${item.state}, not QUEUED.`);
  if (item.nextAttemptAt && Date.parse(now) < Date.parse(item.nextAttemptAt)) {
    throw new WorkbenchError({
      category: "POLICY_BLOCKED",
      code: "RETRY_NOT_READY",
      message: `Retry target ${targetId} is not due until ${item.nextAttemptAt}.`,
      targetId,
      retryable: false,
    });
  }
  item.attempts += 1;
  item.state = "IN_PROGRESS";
  item.nextAttemptAt = null;
  next.updatedAt = now;
  return assertSnapshot(next);
}

export function resolveRetry(
  current: RetryQueueSnapshot,
  targetId: string,
  now: string,
): RetryQueueSnapshot {
  const next = clone(current);
  const item = next.items.find((candidate) => candidate.targetId === targetId);
  if (!item) throw new Error(`Retry target does not exist: ${targetId}`);
  if (item.state !== "IN_PROGRESS") throw new Error(`Retry target ${targetId} is ${item.state}, not IN_PROGRESS.`);
  item.state = "RESOLVED";
  item.nextAttemptAt = null;
  next.updatedAt = now;
  return assertSnapshot(next);
}

export function failRetry(
  current: RetryQueueSnapshot,
  targetId: string,
  failure: TaskError,
  policy: RetryPolicy,
  now: string,
): RetryQueueSnapshot {
  validatePolicy(policy);
  const next = clone(current);
  const item = next.items.find((candidate) => candidate.targetId === targetId);
  if (!item) throw new Error(`Retry target does not exist: ${targetId}`);
  if (item.state !== "IN_PROGRESS") throw new Error(`Retry target ${targetId} is ${item.state}, not IN_PROGRESS.`);
  item.lastError = failure;
  if (failure.category !== "RETRYABLE" || !failure.retryable) {
    item.state = "BLOCKED";
    item.nextAttemptAt = null;
  } else if (item.attempts >= item.maxAttempts) {
    item.state = "EXHAUSTED";
    item.nextAttemptAt = null;
  } else {
    item.state = "QUEUED";
    item.nextAttemptAt = dueAt(now, item.attempts, policy);
  }
  next.updatedAt = now;
  return assertSnapshot(next);
}

export function recoverInterruptedRetries(
  current: RetryQueueSnapshot,
  policy: RetryPolicy,
  now: string,
): RetryQueueSnapshot {
  validatePolicy(policy);
  const next = clone(current);
  for (const item of next.items) {
    if (item.state !== "IN_PROGRESS") continue;
    if (item.attempts >= item.maxAttempts) {
      item.state = "EXHAUSTED";
      item.nextAttemptAt = null;
    } else {
      item.state = "QUEUED";
      item.nextAttemptAt = now;
    }
  }
  next.updatedAt = now;
  return assertSnapshot(next);
}
