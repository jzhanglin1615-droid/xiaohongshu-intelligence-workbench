import { createHash, randomUUID } from "node:crypto";
import type { KeywordPlan } from "../../contracts/src/index.ts";
import type { BrowserCaptureTask, NewBrowserCaptureTask } from "./browser-task-queue.ts";

export type KeywordRunStatus = "QUEUED" | "RUNNING" | "PAUSED" | "CANCEL_REQUESTED" | "CANCELLED" | "SUCCEEDED" | "PARTIAL" | "BLOCKED" | "FAILED";
export interface KeywordRunSettings {
  searchLimit: number;
  requestIntervalMs: number;
  slowNetworkMaxWaitMs: number;
  autoCollectNotes: boolean;
  completeMetrics?: boolean;
  searchScope: "CORE_SEEDS_ONLY" | "ALL_EXPANDED";
  collectionMethod: "CURRENT_PAGE_ALL" | "TOP_N";
  notesPerKeyword: number;
  maxDepth: number;
  maxKeywords: number;
  maxChildrenPerKeyword: number;
}
export interface KeywordBrowserRun {
  runId: string; planId: string; status: KeywordRunStatus; settings: KeywordRunSettings;
  keywords: Array<{ keywordId: string; value: string; depth: number; ordinal: number; searchTaskId: string; detailTaskIds: string[] }>;
  counters: Record<string, number>; createdAt: string; updatedAt: string;
  admittedNoteIds?: string[];
  metricGaps?: Record<string, string[]>;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function normalizeKeywordRunSettings(input: Partial<KeywordRunSettings> = {}): KeywordRunSettings {
  return {
    searchLimit: boundedInteger(input.searchLimit, 1500, 1, 10000),
    requestIntervalMs: boundedInteger(input.requestIntervalMs, 1500, 0, 300_000),
    slowNetworkMaxWaitMs: boundedInteger(input.slowNetworkMaxWaitMs, 300_000, 5_000, 600_000),
    autoCollectNotes: input.autoCollectNotes === true,
    completeMetrics: input.completeMetrics === true,
    searchScope: input.searchScope === "ALL_EXPANDED" ? "ALL_EXPANDED" : "CORE_SEEDS_ONLY",
    collectionMethod: input.collectionMethod === "CURRENT_PAGE_ALL" ? "CURRENT_PAGE_ALL" : "TOP_N",
    notesPerKeyword: boundedInteger(input.notesPerKeyword, 5, 1, 100),
    maxDepth: boundedInteger(input.maxDepth, 3, 0, 5),
    maxKeywords: boundedInteger(input.maxKeywords, 300, 1, 2000),
    maxChildrenPerKeyword: boundedInteger(input.maxChildrenPerKeyword, 10, 1, 100),
  };
}

export function createKeywordBrowserRun(plan: KeywordPlan, settingsInput: Partial<KeywordRunSettings>, now: string, runId = `keyword-run-${randomUUID()}`): { run: KeywordBrowserRun; tasks: NewBrowserCaptureTask[] } {
  const settings = normalizeKeywordRunSettings(settingsInput);
  const nodes = plan.nodes.filter((node) => node.source === "SEED");
  if (!nodes.length) throw new Error("KEYWORD_RUN_EMPTY");
  const keywords = nodes.map((node, index) => ({ keywordId: node.keywordId, value: node.value, depth: node.depth, ordinal: index + 1, searchTaskId: `${runId}-search-${index + 1}`, detailTaskIds: [] as string[] }));
  const tasks = keywords.map<NewBrowserCaptureTask>((keyword) => ({
    taskId: keyword.searchTaskId, sourceId: `keyword-run:${runId}`, expectedPageType: "SEARCH", priority: 70, maxAttempts: 3,
    targetUrl: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword.value)}&source=web_explore_feed`,
    context: { runKind: "KEYWORD", runId, planId: plan.planId, keywordId: keyword.keywordId, keyword: keyword.value, keywordOrdinal: keyword.ordinal, keywordTotal: keywords.length, depth: keyword.depth, searchLimit: settings.searchLimit, noteLimit: settings.notesPerKeyword, requestIntervalMs: settings.requestIntervalMs, slowNetworkMaxWaitMs: settings.slowNetworkMaxWaitMs, autoCollectNotes: settings.autoCollectNotes, collectNotes: settings.autoCollectNotes },
  }));
  return { run: { runId, planId: plan.planId, status: "QUEUED", settings, keywords, counters: { total: tasks.length, queued: tasks.length, leased: 0, succeeded: 0, blocked: 0, failed: 0, cancelled: 0, savedNotes: 0, admittedCards: 0, discoveredCandidates: 0 }, createdAt: now, updatedAt: now }, tasks };
}

export function createDetailTasks(run: KeywordBrowserRun, searchTask: BrowserCaptureTask, cards: Array<{ noteId?: unknown; sourceUrl?: unknown; likes?: unknown; collects?: unknown; comments?: unknown; shares?: unknown; mediaType?: unknown }>): NewBrowserCaptureTask[] {
  if (!run.settings.autoCollectNotes || (!run.settings.completeMetrics && searchTask.context?.collectNotes === false) || searchTask.expectedPageType !== "SEARCH") return [];
  const unique = [...new Map(cards.filter(card => typeof card.noteId === "string" && card.noteId.trim()).map(card => [String(card.noteId), card])).values()];
  if (run.settings.completeMetrics) {
    run.metricGaps ??= {};
    for (const card of unique) run.metricGaps[String(card.noteId)] ??= missingMetrics(card);
  }
  const usable = unique.filter((card) => String(card.mediaType ?? "UNKNOWN").toLocaleUpperCase() !== "VIDEO" && typeof card.sourceUrl === "string" && card.sourceUrl.trim() && (!run.settings.completeMetrics || missingMetrics(card).length > 0));
  const limit = run.settings.completeMetrics ? run.settings.searchLimit : run.settings.collectionMethod === "CURRENT_PAGE_ALL" ? Math.min(100, usable.length) : run.settings.notesPerKeyword;
  const metric = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const ranked = run.settings.collectionMethod === "TOP_N"
    ? [...usable].sort((a, b) => {
        const score = (card: typeof usable[number]) => metric(card.likes) + metric(card.collects) * 2 + metric(card.comments) * 3 + metric(card.shares) * 4;
        return score(b) - score(a) || metric(b.likes) - metric(a.likes);
      })
    : usable;
  const alreadyScheduled = new Set(run.keywords.flatMap(keyword => keyword.detailTaskIds));
  return ranked.slice(0, limit).map<NewBrowserCaptureTask>((card, index) => ({
    taskId: run.settings.completeMetrics ? `${run.runId}-metric-${createHash("sha256").update(String(card.noteId)).digest("hex").slice(0, 16)}` : `${run.runId}-detail-${searchTask.context?.keywordOrdinal ?? 0}-${index + 1}-${String(card.noteId).slice(0, 40)}`,
    sourceId: `keyword-run:${run.runId}`, targetUrl: String(card.sourceUrl), expectedPageType: "NOTE_DETAIL", priority: 60, maxAttempts: 3,
    context: { ...searchTask.context, ...(run.settings.completeMetrics ? { stages: ["DETAIL" as const] } : {}), noteId: String(card.noteId), noteLimit: Math.min(100, limit), navigationMode: "CLICK_SEARCH_CARD", parentSearchUrl: searchTask.targetUrl },
  })).filter(task => !run.settings.completeMetrics || !alreadyScheduled.has(task.taskId));
}

export function missingMetrics(metrics: { likes?: unknown; collects?: unknown; shares?: unknown }): string[] {
  return (["likes", "collects", "shares"] as const).filter(key => typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]) || Number(metrics[key]) < 0);
}

export function createExpansionTasks(run: KeywordBrowserRun, parentTask: BrowserCaptureTask, suggestions: unknown[]): NewBrowserCaptureTask[] {
  const parentDepth = parentTask.context?.depth ?? 0;
  if (parentTask.expectedPageType !== "SEARCH" || parentDepth >= run.settings.maxDepth || run.keywords.length >= run.settings.maxKeywords) return [];
  const existing = new Set(run.keywords.map((item) => item.value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN")));
  const accepted: string[] = [];
  for (const raw of suggestions) {
    const value = typeof raw === "string" ? raw.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
    const normalized = value.toLocaleLowerCase("zh-CN");
    if (!value || existing.has(normalized)) continue;
    existing.add(normalized); accepted.push(value);
    if (accepted.length >= run.settings.maxChildrenPerKeyword || run.keywords.length + accepted.length >= run.settings.maxKeywords) break;
  }
  return accepted.map((value) => {
    const ordinal = run.keywords.length + 1;
    const keywordId = `kw-${createHash("sha256").update(value.toLocaleLowerCase("zh-CN"), "utf8").digest("hex").slice(0, 16)}`;
    const searchTaskId = `${run.runId}-search-${ordinal}`;
    run.keywords.push({ keywordId, value, depth: parentDepth + 1, ordinal, searchTaskId, detailTaskIds: [] });
    return { taskId: searchTaskId, sourceId: `keyword-run:${run.runId}`, expectedPageType: "SEARCH", priority: 70, maxAttempts: 3, targetUrl: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(value)}&source=web_explore_feed`, context: { ...parentTask.context, keywordId, keyword: value, keywordOrdinal: ordinal, keywordTotal: run.settings.maxKeywords, depth: parentDepth + 1, collectNotes: run.settings.autoCollectNotes && run.settings.searchScope === "ALL_EXPANDED" } };
  });
}

export function reconcileKeywordBrowserRun(run: KeywordBrowserRun, allTasks: BrowserCaptureTask[], now: string): KeywordBrowserRun {
  const tasks = allTasks.filter((task) => task.context?.runId === run.runId);
  const count = (status: string) => tasks.filter((task) => task.status === status).length;
  const counters = { total: tasks.length, queued: count("QUEUED"), leased: count("LEASED"), succeeded: count("SUCCEEDED"), skipped: count("SKIPPED"), blocked: count("BLOCKED"), failed: count("FAILED"), cancelled: count("CANCELLED"), savedNotes: tasks.filter((task) => task.expectedPageType === "NOTE_DETAIL" && task.status === "SUCCEEDED").length, admittedCards: Number(run.counters?.admittedCards ?? 0), discoveredCandidates: Number(run.counters?.discoveredCandidates ?? 0) };
  let status: KeywordRunStatus = run.status;
  if (run.status === "CANCELLED") status = "CANCELLED";
  else if (run.status === "PAUSED") status = "PAUSED";
  else if (run.status === "CANCEL_REQUESTED") status = counters.leased ? "CANCEL_REQUESTED" : "CANCELLED";
  else if (counters.total && counters.cancelled === counters.total) status = "CANCELLED";
  else if (counters.blocked) status = "BLOCKED";
  else if (counters.failed) status = "FAILED";
  else if (counters.total && counters.succeeded + counters.skipped === counters.total) status = tasks.some((task) => task.status === "SKIPPED" && task.error?.code !== "QUOTA_REACHED") ? "PARTIAL" : "SUCCEEDED";
  else if (counters.leased || counters.succeeded) status = "RUNNING";
  else status = "QUEUED";
  if (status === "SUCCEEDED" && run.settings.completeMetrics && (Object.values(run.metricGaps ?? {}).some(gaps => gaps.length) || counters.admittedCards < run.settings.searchLimit)) status = "PARTIAL";
  return { ...run, status, counters, updatedAt: now };
}
