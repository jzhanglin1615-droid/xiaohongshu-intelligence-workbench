import { randomUUID } from "node:crypto";

export type BrowserTaskPageType = "SEARCH" | "NOTE_DETAIL";
export type BrowserTaskStatus = "QUEUED" | "LEASED" | "SUCCEEDED" | "SKIPPED" | "BLOCKED" | "FAILED" | "CANCELLED";
export type BrowserTaskFailureCategory = "RETRYABLE" | "NEEDS_HUMAN" | "PERMANENT" | "POLICY_BLOCKED";

export interface BrowserCaptureTask {
  taskId: string;
  sourceId: string;
  targetUrl: string;
  expectedPageType: BrowserTaskPageType;
  priority: number;
  status: BrowserTaskStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lease?: { clientId: string; token: string; expiresAt: string };
  receiptId?: string;
  error?: { category: BrowserTaskFailureCategory; code: string; message: string };
  attemptHistory?: Array<{ attempt: number; at: string; category: BrowserTaskFailureCategory; code: string; message: string }>;
  context?: BrowserTaskContext;
}

export interface BrowserTaskContext {
  runKind?: "KEYWORD" | "RANKING" | "GAP_REFILL";
  runId?: string;
  scopeId?: string;
  monitorId?: string;
  noteId?: string;
  navigationMode?: "CLICK_SEARCH_CARD";
  parentSearchUrl?: string;
  planId?: string;
  keywordId?: string;
  keyword?: string;
  keywordOrdinal?: number;
  keywordTotal?: number;
  depth?: number;
  noteLimit?: number;
  searchLimit?: number;
  requestIntervalMs?: number;
  slowNetworkMaxWaitMs?: number;
  persistentUntilPaused?: boolean;
  autoCollectNotes?: boolean;
  collectNotes?: boolean;
  stages?: Array<"DETAIL" | "COMMENTS">;
}

export interface NewBrowserCaptureTask {
  taskId?: string;
  sourceId: string;
  targetUrl: string;
  expectedPageType: BrowserTaskPageType;
  priority?: number;
  maxAttempts?: number;
  context?: BrowserTaskContext;
}

const clone = <T>(value: T): T => structuredClone(value);

function cleanContext(value?: BrowserTaskContext): BrowserTaskContext | undefined {
  if (!value) return undefined;
  const text = (input: unknown, max = 300) => typeof input === "string" && input.trim() ? input.trim().slice(0, max) : undefined;
  const integer = (input: unknown, min: number, max: number) => Number.isInteger(input) ? Math.max(min, Math.min(max, Number(input))) : undefined;
  return {
    runKind: ["KEYWORD", "RANKING", "GAP_REFILL"].includes(String(value.runKind)) ? value.runKind : undefined,
    runId: text(value.runId, 120), scopeId: text(value.scopeId, 160), monitorId: text(value.monitorId, 120), noteId: text(value.noteId, 160),
    navigationMode: value.navigationMode === "CLICK_SEARCH_CARD" ? value.navigationMode : undefined,
    parentSearchUrl: text(value.parentSearchUrl, 2000),
    planId: text(value.planId, 120), keywordId: text(value.keywordId, 120), keyword: text(value.keyword),
    keywordOrdinal: integer(value.keywordOrdinal, 1, 10_000), keywordTotal: integer(value.keywordTotal, 1, 10_000), depth: integer(value.depth, 0, 20),
    noteLimit: integer(value.noteLimit, 1, 100), searchLimit: integer(value.searchLimit, 1, 10_000), requestIntervalMs: integer(value.requestIntervalMs, 0, 300_000),
    slowNetworkMaxWaitMs: integer(value.slowNetworkMaxWaitMs, 5_000, 600_000), autoCollectNotes: value.autoCollectNotes === true, collectNotes: value.collectNotes === true,
    persistentUntilPaused: value.persistentUntilPaused === true,
    stages: Array.isArray(value.stages) ? [...new Set(value.stages.filter((item): item is "DETAIL" | "COMMENTS" => item === "DETAIL" || item === "COMMENTS"))] : undefined,
  };
}

function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) {
    throw new Error("BROWSER_TASK_TARGET_NOT_ALLOWED");
  }
  return url.href;
}

export class BrowserTaskQueue {
  private readonly tasks: BrowserCaptureTask[];

  constructor(tasks: BrowserCaptureTask[] = []) {
    this.tasks = clone(tasks);
  }

  list(): BrowserCaptureTask[] {
    return clone(this.tasks).sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  enqueue(input: NewBrowserCaptureTask, now: string): BrowserCaptureTask {
    if (!input.sourceId.trim()) throw new Error("BROWSER_TASK_SOURCE_REQUIRED");
    if (!["SEARCH", "NOTE_DETAIL"].includes(input.expectedPageType)) throw new Error("BROWSER_TASK_PAGE_TYPE_INVALID");
    const targetUrl = validateUrl(input.targetUrl);
    const duplicate = this.tasks.find((task) => task.targetUrl === targetUrl
      && task.expectedPageType === input.expectedPageType
      && task.context?.runId === input.context?.runId
      && task.context?.runKind === input.context?.runKind
      && !["FAILED", "SUCCEEDED", "SKIPPED", "BLOCKED", "CANCELLED"].includes(task.status));
    if (duplicate) return clone(duplicate);
    const task: BrowserCaptureTask = {
      taskId: input.taskId?.trim() || `browser-task-${randomUUID()}`,
      sourceId: input.sourceId.trim(),
      targetUrl,
      expectedPageType: input.expectedPageType,
      priority: Number.isFinite(input.priority) ? Math.max(0, Math.min(100, Math.round(input.priority!))) : 50,
      status: "QUEUED",
      attempts: 0,
      maxAttempts: Number.isInteger(input.maxAttempts) ? Math.max(1, Math.min(5, input.maxAttempts!)) : 3,
      createdAt: now,
      updatedAt: now,
      attemptHistory: [],
      context: cleanContext(input.context),
    };
    if (this.tasks.some((item) => item.taskId === task.taskId)) throw new Error("BROWSER_TASK_ID_DUPLICATE");
    this.tasks.push(task);
    return clone(task);
  }

  leaseNext(clientId: string, now: string, leaseMs = 120_000, eligible: (task: BrowserCaptureTask) => boolean = () => true): BrowserCaptureTask | null {
    if (!clientId.trim()) throw new Error("BROWSER_CLIENT_ID_REQUIRED");
    this.recoverExpired(now);
    const task = this.list().find((item) => item.status === "QUEUED" && eligible(item));
    if (!task) return null;
    const target = this.tasks.find((item) => item.taskId === task.taskId)!;
    target.status = "LEASED";
    target.attempts += 1;
    target.updatedAt = now;
    target.lease = { clientId: clientId.trim(), token: randomUUID(), expiresAt: new Date(Date.parse(now) + leaseMs).toISOString() };
    return clone(target);
  }

  complete(taskId: string, token: string, receiptId: string, now: string): BrowserCaptureTask {
    const task = this.requireLease(taskId, token, now);
    if (!receiptId.trim()) throw new Error("BROWSER_TASK_RECEIPT_REQUIRED");
    task.status = "SUCCEEDED";
    task.receiptId = receiptId.trim();
    task.updatedAt = now;
    delete task.lease;
    delete task.error;
    return clone(task);
  }

  fail(taskId: string, token: string, failure: { category: BrowserTaskFailureCategory; code: string; message: string }, now: string): BrowserCaptureTask {
    const task = this.requireLease(taskId, token, now);
    task.error = { category: failure.category, code: failure.code.trim(), message: failure.message.trim() };
    task.attemptHistory ??= [];
    task.attemptHistory.push({ attempt: task.attempts, at: now, ...task.error });
    task.updatedAt = now;
    delete task.lease;
    if (["NEEDS_HUMAN", "POLICY_BLOCKED"].includes(failure.category)) task.status = "BLOCKED";
    else if (failure.category === "RETRYABLE" && (task.context?.persistentUntilPaused === true || task.attempts < task.maxAttempts)) task.status = "QUEUED";
    else task.status = "FAILED";
    return clone(task);
  }

  skip(taskId: string, token: string, reason: { code: string; message: string }, now: string): BrowserCaptureTask {
    const task = this.requireLease(taskId, token, now);
    const code = reason.code.trim();
    const message = reason.message.trim();
    if (!code || !message) throw new Error("BROWSER_TASK_SKIP_REASON_REQUIRED");
    task.error = { category: "PERMANENT", code, message };
    task.attemptHistory ??= [];
    task.attemptHistory.push({ attempt: task.attempts, at: now, ...task.error });
    task.status = "SKIPPED";
    task.updatedAt = now;
    delete task.lease;
    return clone(task);
  }

  recoverExpired(now: string): BrowserCaptureTask[] {
    const recovered: BrowserCaptureTask[] = [];
    for (const task of this.tasks) {
      if (task.status !== "LEASED" || !task.lease || Date.parse(task.lease.expiresAt) > Date.parse(now)) continue;
      delete task.lease;
      task.updatedAt = now;
      task.error = { category: "RETRYABLE", code: "BROWSER_LEASE_EXPIRED", message: "Browser task lease expired before a receipt was committed." };
      task.attemptHistory ??= [];
      task.attemptHistory.push({ attempt: task.attempts, at: now, ...task.error });
      task.status = task.context?.persistentUntilPaused === true || task.attempts < task.maxAttempts ? "QUEUED" : "FAILED";
      recovered.push(clone(task));
    }
    return recovered;
  }

  cancelByRun(runId: string, now: string): BrowserCaptureTask[] {
    const cancelled: BrowserCaptureTask[] = [];
    for (const task of this.tasks) {
      if (task.context?.runId !== runId || task.status !== "QUEUED") continue;
      task.status = "CANCELLED";
      task.updatedAt = now;
      task.error = { category: "PERMANENT", code: "BROWSER_RUN_CANCELLED", message: "The browser run was cancelled before this task was leased." };
      cancelled.push(clone(task));
    }
    return cancelled;
  }

  finishQueuedByRun(runId: string, now: string): BrowserCaptureTask[] {
    const finished: BrowserCaptureTask[] = [];
    for (const task of this.tasks) {
      if (task.context?.runId !== runId || task.status !== "QUEUED" || task.expectedPageType !== "SEARCH") continue;
      task.status = "SKIPPED";
      task.updatedAt = now;
      task.error = { category: "PERMANENT", code: "QUOTA_REACHED", message: "The run's total admitted-post target has been reached." };
      finished.push(clone(task));
    }
    return finished;
  }

  setLeasedSearchLimit(taskId: string, searchLimit: number): BrowserCaptureTask {
    const task = this.tasks.find((item) => item.taskId === taskId);
    if (!task || task.status !== "LEASED" || task.expectedPageType !== "SEARCH") throw new Error("BROWSER_SEARCH_TASK_NOT_LEASED");
    if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 10_000) throw new Error("INVALID_SEARCH_LIMIT");
    task.context = { ...(task.context ?? {}), searchLimit };
    return clone(task);
  }

  private requireLease(taskId: string, token: string, now: string): BrowserCaptureTask {
    const task = this.tasks.find((item) => item.taskId === taskId);
    if (!task) throw new Error("BROWSER_TASK_NOT_FOUND");
    if (task.status !== "LEASED" || !task.lease || task.lease.token !== token) throw new Error("BROWSER_TASK_LEASE_INVALID");
    if (Date.parse(task.lease.expiresAt) <= Date.parse(now)) throw new Error("BROWSER_TASK_LEASE_EXPIRED");
    return task;
  }
}
