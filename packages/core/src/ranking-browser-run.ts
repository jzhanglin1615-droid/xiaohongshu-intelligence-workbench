import { createHash, randomUUID } from "node:crypto";
import type { EnrichmentPlan } from "../../contracts/src/index.ts";
import type { BrowserCaptureTask, NewBrowserCaptureTask } from "./browser-task-queue.ts";
import { missingMetrics } from "./keyword-browser-run.ts";

export type RankingBrowserRunStatus = "QUEUED" | "RUNNING" | "PAUSED" | "CANCEL_REQUESTED" | "CANCELLED" | "SUCCEEDED" | "PARTIAL" | "BLOCKED" | "FAILED";
export type RankingGapDisposition = "REFILLABLE" | "BLOCKED_UNOBSERVABLE" | "REQUIRES_HUMAN" | "PERMANENT";
export type RankingGapStatus = "OPEN" | "REFILL_QUEUED" | "RESOLVED" | "BLOCKED" | "EXHAUSTED";

export interface RankingGapRecord {
  noteId: string;
  code: string;
  disposition: RankingGapDisposition;
  status: RankingGapStatus;
  attempts: number;
  maxAttempts: number;
  sourceTaskId: string;
  refillTaskIds: string[];
  firstSeenAt: string;
  updatedAt: string;
}

export interface RankingBrowserRun {
  runId: string;
  monitorId: string;
  scopeId: string;
  targetUrl: string;
  status: RankingBrowserRunStatus;
  searchTaskId: string;
  enrichmentPlanIds: string[];
  detailTargets: Array<{ noteId: string; taskId: string; priority: number; stages: Array<"DETAIL" | "COMMENTS">; unresolvedGaps: string[] }>;
  dispatchGaps: Array<{ noteId: string; code: "TARGET_URL_MISSING" | "TARGET_SKIPPED_BY_RUN_BUDGET" }>;
  gapRecords: RankingGapRecord[];
  settings: { searchLimit: number; maxDetailTargets: number; maxRefillRounds: number; requestIntervalMs: number; slowNetworkMaxWaitMs: number; completeMetrics?: boolean };
  metricGaps?: Record<string, string[]>;
  counters: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export function createRankingBrowserRun(input: {
  monitorId: string;
  scopeId: string;
  targetUrl: string;
  searchLimit?: number;
  maxDetailTargets?: number;
  completeMetrics?: boolean;
  maxRefillRounds?: number;
  requestIntervalMs?: number;
  slowNetworkMaxWaitMs?: number;
}, now: string, runId = `ranking-run-${randomUUID()}`): { run: RankingBrowserRun; task: NewBrowserCaptureTask } {
  if (!input.monitorId.trim() || !input.scopeId.trim()) throw new Error("RANKING_RUN_IDENTITY_REQUIRED");
  const targetUrl = new URL(input.targetUrl).href;
  const settings = {
    searchLimit: boundedInteger(input.searchLimit, 1500, 1, 10000),
    maxDetailTargets: input.completeMetrics ? boundedInteger(input.searchLimit, 1500, 1, 10000) : boundedInteger(input.maxDetailTargets, 0, 0, 200),
    completeMetrics: input.completeMetrics === true,
    maxRefillRounds: boundedInteger(input.maxRefillRounds, 2, 0, 5),
    requestIntervalMs: boundedInteger(input.requestIntervalMs, 8000, 0, 300_000),
    slowNetworkMaxWaitMs: boundedInteger(input.slowNetworkMaxWaitMs, 300_000, 5_000, 600_000),
  };
  const searchTaskId = `${runId}-search`;
  const run: RankingBrowserRun = {
    runId, monitorId: input.monitorId.trim(), scopeId: input.scopeId.trim(), targetUrl, status: "QUEUED", searchTaskId,
    enrichmentPlanIds: [], detailTargets: [], dispatchGaps: [], gapRecords: [], settings,
    counters: { total: 1, queued: 1, leased: 0, succeeded: 0, skipped: 0, blocked: 0, failed: 0, cancelled: 0, discoveredCandidates: 0, ingestedCandidates: 0, savedNotes: 0, unresolvedGaps: 0 },
    createdAt: now, updatedAt: now,
  };
  return {
    run,
    task: {
      taskId: searchTaskId, sourceId: `ranking-monitor:${run.monitorId}`, targetUrl, expectedPageType: "SEARCH", priority: 100, maxAttempts: 3,
      context: { runKind: "RANKING", runId, scopeId: run.scopeId, monitorId: run.monitorId, searchLimit: settings.searchLimit, requestIntervalMs: settings.requestIntervalMs, slowNetworkMaxWaitMs: settings.slowNetworkMaxWaitMs, persistentUntilPaused: true, autoCollectNotes: settings.maxDetailTargets > 0, collectNotes: settings.maxDetailTargets > 0, noteLimit: settings.maxDetailTargets },
    },
  };
}

const unobservableGaps = new Set([
  "ASSET_EXPECTED_COUNT_NOT_OBSERVABLE",
  "COMMENT_PLATFORM_IDS_NOT_OBSERVABLE",
  "COMMENT_PARENT_REPLY_RELATION_NOT_OBSERVABLE",
  "COMMENT_DECLARED_TOTAL_NOT_OBSERVABLE",
]);
const refillableGaps = new Set(["DETAIL_TITLE_MISSING", "DETAIL_BODY_MISSING", "DETAIL_AUTHOR_MISSING", "DETAIL_METRICS_MISSING"]);

export function classifyRankingGap(code: string): RankingGapDisposition {
  if (unobservableGaps.has(code)) return "BLOCKED_UNOBSERVABLE";
  if (code.includes("HUMAN_REQUIRED")) return "REQUIRES_HUMAN";
  if (refillableGaps.has(code)) return "REFILLABLE";
  return "PERMANENT";
}

export function updateRankingTargetGaps(run: RankingBrowserRun, noteId: string, gaps: string[], sourceTaskId: string, now: string): RankingGapRecord[] {
  run.gapRecords ??= [];
  const current = new Set(gaps);
  for (const record of run.gapRecords.filter((item) => item.noteId === noteId && item.status !== "RESOLVED")) {
    if (!current.has(record.code)) { record.status = "RESOLVED"; record.updatedAt = now; }
  }
  for (const code of [...current].sort()) {
    let record = run.gapRecords.find((item) => item.noteId === noteId && item.code === code);
    const disposition = classifyRankingGap(code);
    if (!record) {
      record = { noteId, code, disposition, status: disposition === "REFILLABLE" ? "OPEN" : "BLOCKED", attempts: 0, maxAttempts: run.settings.maxRefillRounds ?? 2, sourceTaskId, refillTaskIds: [], firstSeenAt: now, updatedAt: now };
      run.gapRecords.push(record);
    } else {
      record.disposition = disposition; record.sourceTaskId = sourceTaskId; record.updatedAt = now;
      if (record.status === "RESOLVED") record.status = disposition === "REFILLABLE" ? "OPEN" : "BLOCKED";
      else if (disposition === "REFILLABLE") record.status = record.attempts >= record.maxAttempts ? "EXHAUSTED" : "OPEN";
      if (disposition !== "REFILLABLE") record.status = "BLOCKED";
    }
  }
  const target = run.detailTargets.find((item) => item.noteId === noteId);
  if (target) target.unresolvedGaps = [...current].sort();
  return run.gapRecords.filter((item) => item.noteId === noteId);
}

export function createRankingGapRefillTasks(run: RankingBrowserRun, sourceTask: BrowserCaptureTask, now: string): NewBrowserCaptureTask[] {
  run.gapRecords ??= [];
  const records = run.gapRecords.filter((item) => item.noteId === sourceTask.context?.noteId && item.disposition === "REFILLABLE" && ["OPEN", "EXHAUSTED"].includes(item.status));
  const eligible = records.filter((item) => item.attempts < item.maxAttempts);
  for (const item of records.filter((record) => record.attempts >= record.maxAttempts)) item.status = "EXHAUSTED";
  if (!eligible.length || !sourceTask.context?.noteId) return [];
  const round = Math.max(...eligible.map((item) => item.attempts)) + 1;
  const taskId = `${run.runId}-refill-${createHash("sha256").update(sourceTask.context.noteId, "utf8").digest("hex").slice(0, 12)}-${round}`;
  for (const record of eligible) {
    record.attempts += 1; record.status = "REFILL_QUEUED"; record.refillTaskIds.push(taskId); record.updatedAt = now;
  }
  return [{
    taskId, sourceId: `ranking-gap-refill:${run.runId}`, targetUrl: sourceTask.targetUrl, expectedPageType: "NOTE_DETAIL", priority: Math.min(100, sourceTask.priority + 1), maxAttempts: 3,
    context: { ...sourceTask.context, runKind: "GAP_REFILL", runId: run.runId, noteId: sourceTask.context.noteId, stages: [...new Set(eligible.map((item) => item.code.startsWith("COMMENT_") ? "COMMENTS" as const : "DETAIL" as const))] },
  }];
}

export function createRankingEnrichmentTasks(
  run: RankingBrowserRun,
  searchTask: BrowserCaptureTask,
  plan: EnrichmentPlan,
  cards: Array<{ noteId?: unknown; sourceUrl?: unknown; mediaType?: unknown; likes?: unknown; collects?: unknown; shares?: unknown }>,
): NewBrowserCaptureTask[] {
  if (searchTask.taskId !== run.searchTaskId || searchTask.expectedPageType !== "SEARCH") return [];
  if (run.settings.maxDetailTargets <= 0 || searchTask.context?.collectNotes === false) return [];
  if (!run.enrichmentPlanIds.includes(plan.planId)) run.enrichmentPlanIds.push(plan.planId);
  const urls = new Map(cards.flatMap((card) => typeof card.noteId === "string" && card.noteId.trim() && typeof card.sourceUrl === "string" && card.sourceUrl.trim() ? [[card.noteId.trim(), card.sourceUrl.trim()]] : []));
  const videoNoteIds = new Set(cards.flatMap((card) => typeof card.noteId === "string" && String(card.mediaType ?? "UNKNOWN").toLocaleUpperCase() === "VIDEO" ? [card.noteId.trim()] : []));
  const existing = new Set(run.detailTargets.map((target) => target.noteId));
  const tasks: NewBrowserCaptureTask[] = [];
  if (run.settings.completeMetrics) {
    run.metricGaps ??= {};
    for (const card of cards) if (typeof card.noteId === "string") run.metricGaps[card.noteId] ??= missingMetrics(card);
  }
  const addDispatchGap = (noteId: string, code: "TARGET_URL_MISSING" | "TARGET_SKIPPED_BY_RUN_BUDGET") => {
    if (!run.dispatchGaps.some((gap) => gap.noteId === noteId && gap.code === code)) run.dispatchGaps.push({ noteId, code });
  };
  const targets = run.settings.completeMetrics
    ? cards.filter(card => typeof card.noteId === "string" && missingMetrics(card).length).map(card => ({ noteId: String(card.noteId), priority: 60, stages: ["DETAIL"] }))
    : plan.tasks;
  for (const target of targets) {
    if (videoNoteIds.has(target.noteId)) continue;
    const targetUrl = urls.get(target.noteId);
    if (existing.has(target.noteId)) continue;
    if (!targetUrl) { addDispatchGap(target.noteId, "TARGET_URL_MISSING"); continue; }
    if (run.detailTargets.length >= run.settings.maxDetailTargets) { addDispatchGap(target.noteId, "TARGET_SKIPPED_BY_RUN_BUDGET"); continue; }
    existing.add(target.noteId);
    const suffix = createHash("sha256").update(target.noteId, "utf8").digest("hex").slice(0, 16);
    const taskId = `${run.runId}-detail-${suffix}`;
    const stages = target.stages.filter((stage): stage is "DETAIL" | "COMMENTS" => stage === "DETAIL" || stage === "COMMENTS");
    run.detailTargets.push({ noteId: target.noteId, taskId, priority: target.priority, stages, unresolvedGaps: [] });
    tasks.push({
      taskId, sourceId: `ranking-run:${run.runId}`, targetUrl, expectedPageType: "NOTE_DETAIL", priority: Math.max(1, Math.min(99, target.priority)), maxAttempts: searchTask.maxAttempts,
      context: { ...searchTask.context, runKind: "RANKING", planId: plan.planId, noteId: target.noteId, stages, navigationMode: "CLICK_SEARCH_CARD", parentSearchUrl: searchTask.targetUrl },
    });
  }
  return tasks;
}

export function reconcileRankingBrowserRun(run: RankingBrowserRun, allTasks: BrowserCaptureTask[], now: string): RankingBrowserRun {
  const tasks = allTasks.filter((task) => ["RANKING", "GAP_REFILL"].includes(String(task.context?.runKind)) && task.context?.runId === run.runId);
  for (const gap of run.gapRecords ?? []) {
    if (gap.status !== "REFILL_QUEUED") continue;
    const refillTasks = tasks.filter((task) => gap.refillTaskIds.includes(task.taskId));
    if (refillTasks.some((task) => task.status === "BLOCKED")) gap.status = "BLOCKED";
    else if (refillTasks.length && refillTasks.every((task) => ["FAILED", "CANCELLED"].includes(task.status))) gap.status = "EXHAUSTED";
  }
  const count = (status: string) => tasks.filter((task) => task.status === status).length;
  const unresolvedGaps = new Set([
    ...(run.dispatchGaps ?? []).map((gap) => `${gap.noteId}:${gap.code}`),
    ...(run.gapRecords ?? []).filter((gap) => gap.status !== "RESOLVED").map((gap) => `${gap.noteId}:${gap.code}`),
    ...(!(run.gapRecords ?? []).length ? run.detailTargets.flatMap((target) => (target.unresolvedGaps ?? []).map((gap) => `${target.noteId}:${gap}`)) : []),
  ]);
  const savedNotes = new Set(tasks.filter((task) => task.expectedPageType === "NOTE_DETAIL" && task.status === "SUCCEEDED" && task.context?.noteId).map((task) => task.context!.noteId)).size;
  const skippedGaps = tasks.filter((task) => task.status === "SKIPPED" && task.context?.noteId).map((task) => `${task.context!.noteId}:${task.error?.code ?? "NOTE_SKIPPED"}`);
  for (const gap of skippedGaps) unresolvedGaps.add(gap);
  const counters = { total: tasks.length, queued: count("QUEUED"), leased: count("LEASED"), succeeded: count("SUCCEEDED"), skipped: count("SKIPPED"), blocked: count("BLOCKED"), failed: count("FAILED"), cancelled: count("CANCELLED"), discoveredCandidates: Number(run.counters?.discoveredCandidates ?? 0), ingestedCandidates: Number(run.counters?.ingestedCandidates ?? 0), savedNotes, unresolvedGaps: unresolvedGaps.size, refillTasks: tasks.filter((task) => task.context?.runKind === "GAP_REFILL").length, blockedGaps: (run.gapRecords ?? []).filter((gap) => gap.status === "BLOCKED").length, exhaustedGaps: (run.gapRecords ?? []).filter((gap) => gap.status === "EXHAUSTED").length };
  let status: RankingBrowserRunStatus = run.status;
  if (run.status === "CANCELLED") status = "CANCELLED";
  else if (run.status === "PAUSED") status = "PAUSED";
  else if (run.status === "CANCEL_REQUESTED") status = counters.leased ? "CANCEL_REQUESTED" : "CANCELLED";
  else if (counters.total && counters.cancelled === counters.total) status = "CANCELLED";
  else if (counters.blocked) status = "BLOCKED";
  else if (counters.failed) status = "FAILED";
  else if (counters.total && counters.succeeded + counters.skipped === counters.total) status = counters.skipped || counters.unresolvedGaps ? "PARTIAL" : "SUCCEEDED";
  else if (counters.leased || counters.succeeded) status = "RUNNING";
  else status = "QUEUED";
  if (run.settings.completeMetrics) {
    if (status === "SUCCEEDED" && (counters.unresolvedGaps || Object.values(run.metricGaps ?? {}).some(gaps => gaps.length) || counters.ingestedCandidates < run.settings.searchLimit)) status = "PARTIAL";
  }
  return { ...run, status, counters, updatedAt: now };
}
