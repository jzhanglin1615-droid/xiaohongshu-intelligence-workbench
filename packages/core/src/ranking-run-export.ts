import { createHash } from "node:crypto";
import type { BrowserCaptureTask } from "./browser-task-queue.ts";
import type { RankingBrowserRun } from "./ranking-browser-run.ts";

export interface RankingRunAuditPayload {
  schemaVersion: "1.0.0";
  exportedAt: string;
  run: RankingBrowserRun;
  tasks: Array<Omit<BrowserCaptureTask, "lease"> & { lease?: { clientId: string; expiresAt: string } }>;
  evidenceReferences: Array<{ taskId: string; receiptId: string; noteId?: string; pageType: BrowserCaptureTask["expectedPageType"] }>;
  summary: {
    taskCount: number;
    taskStatusCounts: Record<string, number>;
    gapCount: number;
    gapStatusCounts: Record<string, number>;
    unresolvedGapCount: number;
    evidenceReferenceCount: number;
  };
}

export interface RankingRunAuditBundle {
  payload: RankingRunAuditPayload;
  receipt: {
    exportId: string;
    runId: string;
    sha256: string;
    byteLength: number;
    taskCount: number;
    gapCount: number;
    evidenceReferenceCount: number;
    createdAt: string;
  };
}

const sensitiveQueryParameter = /^(?:xsec_token|token|access_token|auth|authorization|cookie|signature|sig)$/i;

function sanitizeUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveQueryParameter.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalPayload(payload: RankingRunAuditPayload): string {
  return `${JSON.stringify(stableValue(payload), null, 2)}\n`;
}

function countBy(values: string[]): Record<string, number> {
  return values.sort().reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function sanitizeTask(task: BrowserCaptureTask): RankingRunAuditPayload["tasks"][number] {
  const safe = structuredClone(task) as RankingRunAuditPayload["tasks"][number];
  safe.targetUrl = sanitizeUrl(task.targetUrl);
  if (task.lease) safe.lease = { clientId: task.lease.clientId, expiresAt: task.lease.expiresAt };
  return safe;
}

export function createRankingRunAuditBundle(run: RankingBrowserRun, allTasks: BrowserCaptureTask[], exportedAt: string): RankingRunAuditBundle {
  const safeRun = structuredClone(run);
  safeRun.targetUrl = sanitizeUrl(run.targetUrl);
  const tasks = allTasks
    .filter((task) => task.context?.runId === run.runId && ["RANKING", "GAP_REFILL"].includes(String(task.context?.runKind)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.taskId.localeCompare(right.taskId))
    .map(sanitizeTask);
  const evidenceReferences = tasks
    .filter((task): task is typeof task & { receiptId: string } => Boolean(task.receiptId))
    .map((task) => ({ taskId: task.taskId, receiptId: task.receiptId, noteId: task.context?.noteId, pageType: task.expectedPageType }));
  const gaps = safeRun.gapRecords ?? [];
  const payload: RankingRunAuditPayload = {
    schemaVersion: "1.0.0",
    exportedAt,
    run: safeRun,
    tasks,
    evidenceReferences,
    summary: {
      taskCount: tasks.length,
      taskStatusCounts: countBy(tasks.map((task) => task.status)),
      gapCount: gaps.length,
      gapStatusCounts: countBy(gaps.map((gap) => gap.status)),
      unresolvedGapCount: gaps.filter((gap) => gap.status !== "RESOLVED").length + (safeRun.dispatchGaps ?? []).length,
      evidenceReferenceCount: evidenceReferences.length,
    },
  };
  const serialized = canonicalPayload(payload);
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    payload,
    receipt: {
      exportId: `ranking-audit-${sha256.slice(0, 16)}`,
      runId: run.runId,
      sha256,
      byteLength: new TextEncoder().encode(serialized).byteLength,
      taskCount: tasks.length,
      gapCount: gaps.length,
      evidenceReferenceCount: evidenceReferences.length,
      createdAt: exportedAt,
    },
  };
}

export function verifyRankingRunAuditBundle(bundle: RankingRunAuditBundle): boolean {
  const serialized = canonicalPayload(bundle.payload);
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  return sha256 === bundle.receipt.sha256
    && new TextEncoder().encode(serialized).byteLength === bundle.receipt.byteLength
    && bundle.payload.run.runId === bundle.receipt.runId
    && bundle.payload.tasks.length === bundle.receipt.taskCount
    && (bundle.payload.run.gapRecords ?? []).length === bundle.receipt.gapCount
    && bundle.payload.evidenceReferences.length === bundle.receipt.evidenceReferenceCount;
}
