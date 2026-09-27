import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BrowserTaskQueue, OpenAICompatibleModelGateway, RankingMonitor, SqliteEvidenceStore, buildKeywordPlan, createDetailTasks, createExpansionTasks, createKeywordBrowserRun, createRankingBrowserRun, createRankingEnrichmentTasks, createRankingGapRefillTasks, createRankingRunAuditBundle, ingestBrowserSnapshot, migrateLegacyJsonDatabase, publicProviderState, reconcileKeywordBrowserRun, reconcileRankingBrowserRun, recoverWorkbenchRuntime, restoreSqliteDatabase, updateRankingTargetGaps } from "../../packages/core/src/index.ts";
import { normalizeBrowserHeartbeat, summarizeBrowserBridge } from "./browser-bridge-health.js";
import { deriveAutomaticRankingMonitor } from "./auto-ranking-monitor.js";
import { validateBrowserSnapshotFields } from "./browser-field-validation.js";
import { createBrowserHumanComparison } from "./browser-human-comparison.js";
import { matchesBrowserTaskTarget } from "./browser-task-target.js";
import { collectXhsKeyword } from "./opencli-xhs-collector.js";
import { readModelSettings, restoreModelSecrets, transformSecret } from "./model-settings.mjs";
import { appendDiscoveredKeywords, applyKeywordFailure, applyKeywordResult, createRealKeywordResearchRun, discoverRelatedKeywords, isResearchRunActive, nextResearchKeyword, publicResearchRun, rebuildResearchInsights, sanitizeResearchError, sanitizeStoredResearchRun } from "./real-keyword-research.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.XHS_WORKBENCH_PORT ?? 4173);
const serviceStartedAt = new Date().toISOString();
const providerConfigPath = path.join(projectRoot, "config/model-providers.json");
const modelSettingsPath = path.join(projectRoot, "state/model-connector-settings.json");
const modelSecretScriptPath = path.join(projectRoot, "scripts/model-secret.ps1");
const runtimeStatePath = path.join(projectRoot, "state/workbench-runtime.json");
const projectStatePath = path.join(projectRoot, "state/project-state.json");
const viewHistoryPath = path.join(projectRoot, "state/view-history.json");
const marketStatePath = path.join(projectRoot, "state/market-workbench.json");
const reportPath = path.join(projectRoot, "artifacts/m5-explainable-analysis/report.json");
const databasePath = path.join(projectRoot, "artifacts/m5-explainable-analysis/collection/database.json");
const browserSnapshotRoot = path.join(projectRoot, "state/browser-bridge/snapshots");
const browserFieldValidationRoot = path.join(projectRoot, "state/browser-bridge/field-validations");
const browserHumanValidationRoot = path.join(projectRoot, "state/browser-bridge/human-validations");
const browserEvidenceDatabasePath = path.resolve(process.env.XHS_EVIDENCE_DATABASE_PATH ?? path.join(projectRoot, "state/browser-bridge/evidence-database.sqlite"));
const legacyBrowserEvidenceDatabasePath = path.resolve(process.env.XHS_LEGACY_EVIDENCE_DATABASE_PATH ?? path.join(projectRoot, "state/browser-bridge/evidence-database.json"));
const databaseBackupRoot = path.resolve(process.env.XHS_DATABASE_BACKUP_ROOT ?? path.join(projectRoot, "state/browser-bridge/backups"));
const databaseReceiptRoot = path.resolve(process.env.XHS_DATABASE_RECEIPT_ROOT ?? path.join(projectRoot, "state/browser-bridge/maintenance-receipts"));
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8" };
const gateway = new OpenAICompatibleModelGateway();
let collectionActive = false;
let collectionJob = null;
let monitor;
let startupMigration = null;
let realCollectionActive = false;
let realCollectorState = null;
let researchExecutionActive = false;
const researchControls = new Map();
const providerVerification = new Map();
const jsonWriteQueues = new Map();

const readJson = async (file) => {
  const pending = jsonWriteQueues.get(file);
  if (pending) await pending;
  return JSON.parse(await readFile(file, "utf8"));
};
const readCurrentModelSettings = async () => {
  const pending = jsonWriteQueues.get(modelSettingsPath);
  if (pending) await pending;
  return readModelSettings(modelSettingsPath);
};
const readMarketState = async () => readJson(marketStatePath).catch((error) => {
  if (error?.code === "ENOENT") return { direction: "", preciseTerms: [], archives: [], favorites: [], updatedAt: null };
  throw error;
});
const writeJson = (file, value) => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const previous = jsonWriteQueues.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, "utf8");
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
  jsonWriteQueues.set(file, pending);
  const cleanup = () => { if (jsonWriteQueues.get(file) === pending) jsonWriteQueues.delete(file); };
  pending.then(cleanup, cleanup);
  return pending;
};
const readProviderConfig = async () => {
  const [config, settings] = await Promise.all([readJson(providerConfigPath), readCurrentModelSettings()]);
  return { ...config, apiEnabled: settings.apiEnabled === true, providers: config.providers.map((provider) => ({ ...provider, baseUrl: settings.providers[provider.providerId]?.baseUrl ?? provider.baseUrl })) };
};
const requireModelApiEnabled = async () => {
  if (!(await readCurrentModelSettings()).apiEnabled) throw new Error("MODEL_API_DISABLED");
};
const initializeModelSettings = async () => {
  const settings = await readCurrentModelSettings();
  const config = await readJson(providerConfigPath);
  if (await restoreModelSecrets(settings, config.providers, modelSecretScriptPath)) await writeJson(modelSettingsPath, settings);
};
const sendJson = (response, statusCode, value) => {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
const allowedApiOrigin = (origin) =>
  origin === `http://127.0.0.1:${port}` ||
  origin === `http://localhost:${port}` ||
  /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
  /^moz-extension:\/\/[0-9a-f-]{36}$/.test(origin);
const parseBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const joined = Buffer.concat(chunks);
  if (joined.byteLength === 0) return {};
  if (joined.byteLength > 1_000_000) throw new Error("REQUEST_BODY_TOO_LARGE");
  return JSON.parse(joined.toString("utf8"));
};
const parseBinaryBody = async (request, maximumBytes = 256 * 1024 * 1024) => {
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.byteLength; if (total > maximumBytes) throw new Error("RESTORE_FILE_TOO_LARGE"); chunks.push(chunk); }
  if (total === 0) throw new Error("RESTORE_FILE_REQUIRED");
  return Buffer.concat(chunks);
};
const requireExternalConfirmation = (body) => {
  if (body.confirmExternalCall !== true) throw new Error("EXTERNAL_CALL_CONFIRMATION_REQUIRED");
};
const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const escapeMarkdown = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
const sendDownload = (response, contentType, filename, content) => {
  const body = Buffer.from(content, "utf8");
  response.writeHead(200, {
    "content-type": contentType,
    "content-disposition": `attachment; filename=${filename}`,
    "cache-control": "no-store",
    "x-content-sha256": createHash("sha256").update(body).digest("hex"),
    "x-content-bytes": String(body.byteLength),
  });
  response.end(body);
};
const runtimeState = async () => readJson(runtimeStatePath);
const publicProvider = (provider) => ({ ...publicProviderState(provider), ...(providerVerification.get(provider.providerId) ?? { verified: false, verifiedAt: null, modelCount: null }) });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function publicResearchSummary(run) {
  const value = publicResearchRun(run);
  if (!value) return null;
  value.queue = (value.queue ?? []).map(({ topCards: _topCards, errors, ...keyword }) => ({ ...keyword, errorCount: errors?.length ?? 0 }));
  return value;
}

async function readViewHistory() {
  try { return await readJson(viewHistoryPath); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: "1.0.0", updatedAt: null, entries: [] };
  }
}

function reconcileKeywordRuns(runtime, now = new Date().toISOString()) {
  runtime.keywordRuns = (runtime.keywordRuns ?? []).map((run) => reconcileKeywordBrowserRun(run, runtime.browserTasks ?? [], now));
  return runtime.keywordRuns;
}

function reconcileRankingRuns(runtime, now = new Date().toISOString()) {
  runtime.rankingRuns = (runtime.rankingRuns ?? []).map((run) => reconcileRankingBrowserRun(run, runtime.browserTasks ?? [], now));
  return runtime.rankingRuns;
}

function currentCollectionProgress(runtime) {
  const activeStatuses = ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"];
  const runs = [
    ...(runtime.keywordRuns ?? []).map((run) => ({ runKind: "KEYWORD", run })),
    ...(runtime.rankingRuns ?? []).map((run) => ({ runKind: "RANKING", run })),
  ];
  const current = runs.filter(({ run }) => activeStatuses.includes(run.status))
    .sort((a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt))[0]
    ?? runs.sort((a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt))[0]
    ?? null;
  if (!current) return { runKind: null, run: null, active: false, target: 0, admitted: 0, discovered: 0, completed: 0, total: 0, percent: 0 };
  const { runKind, run } = current;
  const target = Number(run.settings?.searchLimit ?? 0);
  const admitted = Number(run.counters?.[runKind === "KEYWORD" ? "admittedCards" : "ingestedCandidates"] ?? 0);
  const discovered = Number(run.counters?.discoveredCandidates ?? 0);
  const completed = Number(run.counters?.succeeded ?? 0) + Number(run.counters?.skipped ?? 0);
  const total = Number(run.counters?.total ?? 0);
  return { runKind, run, active: activeStatuses.includes(run.status), target, admitted, discovered, completed, total, percent: target ? Math.min(100, Math.round(admitted / target * 100)) : 0 };
}

async function saveCollectionHistory(entry) {
  const runtime = await runtimeState();
  runtime.collectionHistory = [entry, ...(runtime.collectionHistory ?? []).filter((item) => item.jobId !== entry.jobId)].slice(0, 20);
  runtime.updatedAt = new Date().toISOString();
  await writeJson(runtimeStatePath, runtime);
}

async function persistRankingMonitorReceipt(receipt) {
  const runtime = await runtimeState();
  runtime.rankingMonitorReceipts = [...(runtime.rankingMonitorReceipts ?? []).filter((item) => item.runId !== receipt.runId), receipt].slice(-200);
  runtime.updatedAt = new Date().toISOString();
  await writeJson(runtimeStatePath, runtime);
}

async function persistRankingMonitorSchedule(schedule) {
  const runtime = await runtimeState();
  runtime.rankingMonitorSchedule = schedule;
  runtime.updatedAt = new Date().toISOString();
  await writeJson(runtimeStatePath, runtime);
}

async function persistRealCollectorState(next, terminal = false) {
  realCollectorState = structuredClone(next);
  const runtime = await runtimeState();
  runtime.realCollector = structuredClone(next);
  if (terminal) runtime.realCollectorHistory = [structuredClone(next), ...(runtime.realCollectorHistory ?? [])].slice(0, 30);
  runtime.updatedAt = new Date().toISOString();
  await writeJson(runtimeStatePath, runtime);
}

async function persistResearchRun(run) {
  const runtime = await runtimeState();
  runtime.researchRuns = [structuredClone(run), ...(runtime.researchRuns ?? []).filter((item) => item.runId !== run.runId)].slice(0, 20);
  runtime.updatedAt = new Date().toISOString();
  await writeJson(runtimeStatePath, runtime);
}

async function existingEvidenceNoteIds() {
  const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
  try { return (await store.listNotes()).map((note) => note.noteId); }
  finally { store.close(); }
}

async function researchCheckpoint(run, phase = run.phase) {
  run.phase = phase;
  const control = researchControls.get(run.runId) ?? run.control ?? { pauseRequested: false, cancelRequested: false };
  run.control = { ...control };
  if (control.cancelRequested) {
    run.status = "CANCEL_REQUESTED";
    run.updatedAt = new Date().toISOString();
    await persistResearchRun(run);
    throw new Error("RESEARCH_CANCELLED");
  }
  if (control.pauseRequested) {
    if (run.status !== "PAUSED") {
      run.status = "PAUSED";
      run.phase = "已暂停，可随时继续";
      run.updatedAt = new Date().toISOString();
      await persistResearchRun(run);
    }
    while ((researchControls.get(run.runId) ?? control).pauseRequested) {
      const latest = researchControls.get(run.runId) ?? control;
      if (latest.cancelRequested) throw new Error("RESEARCH_CANCELLED");
      await wait(300);
    }
    run.control = { ...(researchControls.get(run.runId) ?? { pauseRequested: false, cancelRequested: false }) };
    run.status = "RUNNING";
    run.phase = phase;
    run.updatedAt = new Date().toISOString();
    await persistResearchRun(run);
  }
}

async function interruptibleResearchDelay(run, milliseconds) {
  let remaining = Math.max(0, milliseconds);
  while (remaining > 0) {
    await researchCheckpoint(run, "温和间隔，准备下一个关键词");
    const step = Math.min(500, remaining);
    await wait(step);
    remaining -= step;
  }
}

async function executeResearchRun(runId) {
  if (researchExecutionActive) return;
  const runtime = await runtimeState();
  const run = (runtime.researchRuns ?? []).find((item) => item.runId === runId);
  if (!isResearchRunActive(run)) return;
  researchExecutionActive = true;
  researchControls.set(run.runId, researchControls.get(run.runId) ?? run.control ?? { pauseRequested: false, cancelRequested: false });
  let ownsCollectorSlot = false;
  try {
    if (realCollectionActive) {
      run.phase = "等待本轮榜单刷新结束";
      run.updatedAt = new Date().toISOString();
      await persistResearchRun(run);
    }
    while (realCollectionActive) {
      await researchCheckpoint(run, "等待本轮榜单刷新结束");
      await wait(500);
    }
    realCollectionActive = true;
    ownsCollectorSlot = true;
    await researchCheckpoint(run, "准备真实搜索");
    run.status = "RUNNING";
    run.startedAt ??= new Date().toISOString();
    run.updatedAt = new Date().toISOString();
    await persistResearchRun(run);

    const knownNoteIds = new Set(await existingEvidenceNoteIds());
    let keyword;
    while ((keyword = nextResearchKeyword(run))) {
      await researchCheckpoint(run, `搜索：${keyword.value}`);
      keyword.status = "RUNNING";
      keyword.startedAt ??= new Date().toISOString();
      run.currentKeywordId = keyword.keywordId;
      run.currentKeyword = keyword.value;
      run.updatedAt = new Date().toISOString();
      await persistResearchRun(run);
      try {
        const monitorConfig = (await runtimeState()).rankingMonitor ?? {};
        const result = await collectXhsKeyword({
          keyword: keyword.value,
          profile: String(monitorConfig.opencliProfile || "ufbrj4yc"),
          searchLimit: run.settings.searchLimit,
          detailLimit: run.settings.notesPerKeyword,
          commentLimit: run.settings.commentLimit,
          existingNoteIds: [...knownNoteIds],
          databasePath: browserEvidenceDatabasePath,
          snapshotRoot: browserSnapshotRoot,
          projectRoot,
          async onProgress(progress) {
            run.phase = progress.phase === "SEARCH" ? `搜索：${keyword.value}` : progress.phase === "DETAIL" ? `读取详情与评论：${progress.completed}/${progress.total}` : `整理：${keyword.value}`;
            keyword.progress = { completed: Number(progress.completed ?? 0), total: Number(progress.total ?? 0), attempted: Number(progress.attempted ?? 0), noteId: progress.noteId ?? null };
            run.updatedAt = new Date().toISOString();
            await persistResearchRun(run);
          },
        });
        applyKeywordResult(run, keyword, result);
        for (const noteId of result.normalizedNoteIds ?? []) knownNoteIds.add(noteId);
        if (run.settings.expandFromResults) {
          const candidates = discoverRelatedKeywords({ parentKeyword: keyword.value, cards: result.searchCards, existingKeywords: run.queue.map((item) => item.value), limit: run.settings.maxChildrenPerKeyword });
          appendDiscoveredKeywords(run, keyword, candidates);
        }
        rebuildResearchInsights(run);
      } catch (error) {
        if (error instanceof Error && error.message === "RESEARCH_CANCELLED") throw error;
        applyKeywordFailure(run, keyword, error);
      }
      run.currentKeywordId = null;
      run.currentKeyword = null;
      run.updatedAt = new Date().toISOString();
      await persistResearchRun(run);
      if (nextResearchKeyword(run)) await interruptibleResearchDelay(run, run.settings.requestIntervalMs);
    }
    const hasPartialKeyword = run.queue.some((item) => ["PARTIAL", "FAILED"].includes(item.status));
    run.status = run.counters.savedNotes === 0 ? "FAILED" : hasPartialKeyword ? "PARTIAL" : "SUCCEEDED";
    run.phase = run.status === "SUCCEEDED" ? "采集完成" : run.status === "PARTIAL" ? "完成，部分结果未达到完整性要求" : "未采到可入库的完整作品";
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    rebuildResearchInsights(run);
    await persistResearchRun(run);
  } catch (error) {
    const cancelled = error instanceof Error && error.message === "RESEARCH_CANCELLED";
    run.status = cancelled ? "CANCELLED" : "FAILED";
    run.phase = cancelled ? "已停止" : "任务失败";
    run.lastError = cancelled ? null : sanitizeResearchError(error).message;
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    await persistResearchRun(run);
  } finally {
    if (ownsCollectorSlot) realCollectionActive = false;
    researchExecutionActive = false;
    researchControls.delete(runId);
  }
}

async function collectRealRanking(config, scopeId) {
  if (realCollectionActive) throw new Error("REAL_COLLECTION_ALREADY_ACTIVE");
  const target = new URL(config.targetUrl);
  const keyword = target.searchParams.get("keyword")?.trim() || "小红书";
  const runId = `opencli-ranking-${Date.now()}`;
  const startedAt = new Date().toISOString();
  realCollectionActive = true;
  await persistRealCollectorState({ runId, status: "RUNNING", phase: "SEARCH", keyword, scopeId, completed: 0, total: 1, startedAt, updatedAt: startedAt });
  try {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    let existingNoteIds;
    try { existingNoteIds = (await store.listNotes()).map((note) => note.noteId); }
    finally { store.close(); }
    const result = await collectXhsKeyword({
      keyword,
      profile: String(config.opencliProfile || "ufbrj4yc"),
      searchLimit: Number(config.searchLimit || 1500),
      detailLimit: Number(config.maxDetailTargets ?? 0),
      commentLimit: Number(config.commentLimit || 50),
      existingNoteIds,
      databasePath: browserEvidenceDatabasePath,
      snapshotRoot: browserSnapshotRoot,
      projectRoot,
      onProgress(progress) {
        realCollectorState = { ...realCollectorState, ...progress, status: "RUNNING", updatedAt: new Date().toISOString() };
      },
    });
    const finished = {
      runId,
      status: result.status,
      phase: "COMPLETE",
      keyword,
      scopeId,
      searchCardCount: result.searchCardCount,
      detailAttempted: result.detailAttempted,
      detailSucceeded: result.detailSucceeded,
      capturedCommentCount: result.capturedCommentCount,
      fetchedCommentCount: result.fetchedCommentCount,
      filteredOutCommentCount: result.filteredOutCommentCount,
      rejectedDetailCount: result.rejectedDetailReceipts?.length ?? 0,
      normalizedNoteIds: result.normalizedNoteIds,
      errors: result.errors,
      rankingSnapshotId: result.rankingSnapshotId,
      startedAt,
      finishedAt: result.finishedAt,
      updatedAt: result.finishedAt,
    };
    await persistRealCollectorState(finished, true);
    return { snapshotId: result.rankingSnapshotId ?? result.searchReceiptId };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const failed = { runId, status: "FAILED", phase: "TERMINAL", keyword, scopeId, error: error instanceof Error ? error.message : "OPENCLI_COLLECTION_FAILED", startedAt, finishedAt, updatedAt: finishedAt };
    await persistRealCollectorState(failed, true);
    throw error;
  } finally {
    realCollectionActive = false;
  }
}

async function recoverRuntimeAtStartup() {
  const runtime = await runtimeState();
  const result = recoverWorkbenchRuntime(runtime, new Date().toISOString());
  result.runtime.researchRuns = (result.runtime.researchRuns ?? []).map((storedRun) => {
    const run = sanitizeStoredResearchRun(storedRun);
    if (!isResearchRunActive(run)) return run;
    return { ...run, status: "PAUSED", phase: "服务已恢复，点击继续", control: { pauseRequested: true, cancelRequested: false }, updatedAt: new Date().toISOString() };
  });
  await writeJson(runtimeStatePath, result.runtime);
  return result.receipt;
}

async function collectionCheckpoint(phase) {
  if (!collectionJob) throw new Error("COLLECTION_JOB_MISSING");
  collectionJob.phase = phase;
  collectionJob.updatedAt = new Date().toISOString();
  if (collectionJob.cancelRequested) throw new Error("COLLECTION_CANCELLED");
  while (collectionJob.pauseRequested) {
    collectionJob.status = "PAUSED";
    collectionJob.updatedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (collectionJob.cancelRequested) throw new Error("COLLECTION_CANCELLED");
  }
  collectionJob.status = "RUNNING";
}

async function executeCollectionJob(jobId) {
  collectionActive = true;
  const abortController = new AbortController();
  collectionJob.abortController = abortController;
  try {
    await collectionCheckpoint("PREPARE");
    await collectionCheckpoint("COLLECT_AND_ANALYZE");
    const result = await execFileAsync(process.execPath, ["--experimental-strip-types", "apps/fixture-runner/src/intelligence-cli.ts"], { cwd: projectRoot, timeout: 120_000, windowsHide: true, signal: abortController.signal });
    await collectionCheckpoint("FINALIZE");
    collectionJob = { ...collectionJob, abortController: undefined, status: "SUCCEEDED", phase: "COMPLETE", output: result.stdout.trim(), finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  } catch (error) {
    const cancelled = collectionJob?.cancelRequested || (error instanceof Error && ["COLLECTION_CANCELLED", "The operation was aborted"].includes(error.message));
    collectionJob = { ...collectionJob, abortController: undefined, status: cancelled ? "CANCELLED" : "FAILED", phase: "TERMINAL", error: cancelled ? "USER_CANCELLED" : (error instanceof Error ? error.message : "COLLECTION_FAILED"), finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  } finally {
    collectionActive = false;
    if (collectionJob?.jobId === jobId) await saveCollectionHistory({ ...collectionJob, abortController: undefined });
  }
}

async function rebuildMonitor() {
  monitor?.stop();
  const runtime = await runtimeState();
  const config = runtime.rankingMonitor;
  // Scheduled checks are presence-gated below; the monitor remains available for immediate runs.
  monitor = new RankingMonitor({ monitorId: "primary-ranking-monitor", scopeId: config.scopeId, intervalMs: config.intervalMinutes * 60_000, enabled: false }, {
    async capture(scopeId) {
      if (config.mode === "REAL_ADAPTER") {
        if (!config.targetUrl) throw new Error("RANKING_TARGET_URL_REQUIRED");
        if (config.collectorKind !== "EXTENSION") return collectRealRanking(config, scopeId);
        const current = await runtimeState();
        const queue = new BrowserTaskQueue(current.browserTasks ?? []);
        const now = new Date().toISOString();
        reconcileRankingRuns(current, now);
        const before = queue.list().find((task) => task.targetUrl === new URL(config.targetUrl).href && task.expectedPageType === "SEARCH" && ["QUEUED", "LEASED"].includes(task.status));
        let task = before;
        let rankingRun = before?.context?.runId ? (current.rankingRuns ?? []).find((item) => item.runId === before.context.runId) : null;
        if (!task) {
          const created = createRankingBrowserRun({ monitorId: "primary-ranking-monitor", scopeId, targetUrl: config.targetUrl, searchLimit: config.searchLimit, completeMetrics: true, maxDetailTargets: config.maxDetailTargets, maxRefillRounds: 0, requestIntervalMs: config.requestIntervalMs, slowNetworkMaxWaitMs: config.slowNetworkMaxWaitMs }, now);
          rankingRun = created.run;
          task = queue.enqueue(created.task, now);
          current.rankingRuns = [rankingRun, ...(current.rankingRuns ?? [])].slice(0, 50);
        }
        const dispatch = { dispatchId: `ranking-dispatch-${Date.now()}`, rankingRunId: rankingRun?.runId ?? null, monitorId: "primary-ranking-monitor", scopeId, targetUrl: task.targetUrl, browserTaskId: task.taskId, status: before ? "DEDUPLICATED_ACTIVE_TASK" : "DISPATCHED", createdAt: now };
        current.browserTasks = queue.list();
        current.rankingDispatchHistory = [dispatch, ...(current.rankingDispatchHistory ?? [])].slice(0, 50);
        current.updatedAt = now;
        await writeJson(runtimeStatePath, current);
        return { kind: "BROWSER_TASK", browserTaskId: task.taskId };
      }
      const report = await readJson(reportPath);
      const snapshot = report.rankingSnapshots?.at(-1);
      if (!snapshot) throw new Error("NO_RANKING_SNAPSHOT");
      return { snapshotId: snapshot.snapshotId };
    },
  }, undefined, {
    initialReceipts: runtime.rankingMonitorReceipts ?? [],
    initialSchedule: runtime.rankingMonitorSchedule ?? null,
    onReceipt: persistRankingMonitorReceipt,
    onSchedule: persistRankingMonitorSchedule,
  });
  monitor.start();
}

async function apiRoute(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: "READY",
      service: "xhs-intelligence-workbench",
      version: "0.1.0",
      pid: process.pid,
      port,
      startedAt: serviceStartedAt,
      generatedAt: new Date().toISOString(),
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-bridge/status") {
    const runtime = await runtimeState();
    sendJson(response, 200, { status: "READY", ...summarizeBrowserBridge(runtime), generatedAt: new Date().toISOString() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-bridge/field-validation/latest") {
    const runtime = await runtimeState();
    sendJson(response, 200, { fieldValidation: runtime.browserBridge?.lastFieldValidation ?? null });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-bridge/human-comparison/latest") {
    const runtime = await runtimeState();
    sendJson(response, 200, { humanComparison: runtime.browserBridge?.lastHumanComparison ?? null });
    return true;
  }
  const humanComparisonMatch = url.pathname.match(/^\/api\/browser-bridge\/field-validation\/([^/]+)\/human-comparison$/);
  if (request.method === "POST" && humanComparisonMatch) {
    const receiptId = decodeURIComponent(humanComparisonMatch[1]);
    if (!/^browser-\d+-[a-f0-9]{10}$/i.test(receiptId)) throw new Error("INVALID_FIELD_VALIDATION_RECEIPT_ID");
    let fieldValidation;
    try { fieldValidation = await readJson(path.join(browserFieldValidationRoot, `${receiptId}.json`)); }
    catch (error) { if (error?.code === "ENOENT") throw new Error("FIELD_VALIDATION_RECEIPT_NOT_FOUND"); throw error; }
    const comparison = createBrowserHumanComparison(fieldValidation, await parseBody(request));
    await mkdir(browserHumanValidationRoot, { recursive: true });
    const comparisonPath = path.join(browserHumanValidationRoot, `${comparison.comparisonId}.json`);
    await writeJson(comparisonPath, comparison);
    const runtime = await runtimeState();
    const previous = runtime.browserBridge ?? {};
    const comparisonRecord = { ...comparison, reportPath: path.relative(projectRoot, comparisonPath) };
    runtime.browserBridge = {
      ...previous,
      lastHumanComparison: comparisonRecord,
      humanComparisons: [comparisonRecord, ...(previous.humanComparisons ?? []).filter((item) => item.comparisonId !== comparison.comparisonId)].slice(0, 100),
    };
    runtime.updatedAt = new Date().toISOString();
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 201, { humanComparison: comparisonRecord });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/heartbeat") {
    const body = await parseBody(request);
    const now = new Date().toISOString();
    const heartbeat = normalizeBrowserHeartbeat(body, now);
    const runtime = await runtimeState();
    const previous = runtime.browserBridge ?? {};
    const clients = [heartbeat, ...(previous.clients ?? []).filter((item) => item.clientId !== heartbeat.clientId)].slice(0, 20);
    runtime.browserBridge = { ...previous, clients, lastHeartbeat: heartbeat };
    const automaticMonitor = deriveAutomaticRankingMonitor(runtime.rankingMonitor, heartbeat);
    if (automaticMonitor.changed) runtime.rankingMonitor = automaticMonitor.config;
    runtime.updatedAt = now;
    await writeJson(runtimeStatePath, runtime);
    if (automaticMonitor.changed) await rebuildMonitor();
    sendJson(response, 200, { status: "ACCEPTED", bridge: summarizeBrowserBridge(runtime, now), automaticMonitor: { changed: automaticMonitor.changed, reason: automaticMonitor.reason, config: automaticMonitor.changed ? automaticMonitor.config : undefined } });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-bridge/tasks") {
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    const recovered = queue.recoverExpired(new Date().toISOString());
    if (recovered.length) { runtime.browserTasks = queue.list(); runtime.updatedAt = new Date().toISOString(); await writeJson(runtimeStatePath, runtime); }
    const status = url.searchParams.get("status");
    const tasks = queue.list().filter((task) => !status || task.status === status);
    sendJson(response, 200, { tasks, recoveredCount: recovered.length });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/tasks") {
    const body = await parseBody(request);
    if (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 200) throw new Error("INVALID_BROWSER_TASK_BATCH");
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    const now = new Date().toISOString();
    const accepted = body.tasks.map((task) => queue.enqueue(task, now));
    runtime.browserTasks = queue.list(); runtime.updatedAt = now; await writeJson(runtimeStatePath, runtime);
    sendJson(response, 202, { accepted, total: runtime.browserTasks.length });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/tasks/lease") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    const runById = new Map((runtime.keywordRuns ?? []).map((run) => [run.runId, run]));
    const rankingRunById = new Map((runtime.rankingRuns ?? []).map((run) => [run.runId, run]));
    const leaseNow = new Date().toISOString();
    for (const run of runtime.keywordRuns ?? []) if (Number(run.counters?.admittedCards ?? 0) >= Number(run.settings?.searchLimit ?? Infinity)) queue.finishQueuedByRun(run.runId, leaseNow);
    let task = queue.leaseNext(String(body.clientId ?? ""), leaseNow, 10 * 60_000, (candidate) => {
      const run = candidate.context?.runId ? runById.get(candidate.context.runId) : null;
      const rankingRun = candidate.context?.runId ? rankingRunById.get(candidate.context.runId) : null;
      if (candidate.context?.runKind === "KEYWORD") return !!run && ["QUEUED", "RUNNING"].includes(run.status);
      if (candidate.context?.runKind === "RANKING") return !!rankingRun && ["QUEUED", "RUNNING"].includes(rankingRun.status);
      return true;
    });
    if (task?.context?.runKind === "KEYWORD" && task.expectedPageType === "SEARCH") {
      const run = runById.get(task.context.runId);
      if (run) task = queue.setLeasedSearchLimit(task.taskId, Math.max(1, Number(run.settings.searchLimit) - Number(run.counters?.admittedCards ?? 0)));
    }
    runtime.browserTasks = queue.list(); reconcileKeywordRuns(runtime); runtime.updatedAt = new Date().toISOString(); await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { task });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/tasks/fail") {
    const body = await parseBody(request);
    const category = String(body.category ?? "");
    if (!["RETRYABLE", "NEEDS_HUMAN", "PERMANENT", "POLICY_BLOCKED"].includes(category)) throw new Error("INVALID_BROWSER_TASK_FAILURE_CATEGORY");
    const code = String(body.code ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!code || !message) throw new Error("INVALID_BROWSER_TASK_FAILURE");
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    const task = queue.fail(String(body.taskId ?? ""), String(body.leaseToken ?? ""), { category, code, message }, new Date().toISOString());
    runtime.browserTasks = queue.list();
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    runtime.updatedAt = new Date().toISOString();
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { task });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/tasks/skip") {
    const body = await parseBody(request);
    const code = String(body.code ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!code || !message) throw new Error("INVALID_BROWSER_TASK_SKIP_REASON");
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    const task = queue.skip(String(body.taskId ?? ""), String(body.leaseToken ?? ""), { code, message }, new Date().toISOString());
    runtime.browserTasks = queue.list();
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    runtime.updatedAt = new Date().toISOString();
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { task });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/browser-bridge/snapshot") {
    const body = await parseBody(request);
    const bridgeTask = body.bridgeTask;
    let source;
    try { source = new URL(String(body.sourceUrl ?? "")); } catch { throw new Error("INVALID_SNAPSHOT_URL"); }
    if (source.protocol !== "https:" || !/(^|\.)xiaohongshu\.com$/i.test(source.hostname)) throw new Error("SNAPSHOT_SOURCE_NOT_ALLOWED");
    if (!["SEARCH", "NOTE_DETAIL", "UNKNOWN"].includes(body.pageType)) throw new Error("INVALID_SNAPSHOT_PAGE_TYPE");
    if (!["VISIBLE", "HUMAN_REQUIRED", "UNKNOWN_STRUCTURE"].includes(body.status)) throw new Error("INVALID_SNAPSHOT_STATUS");
    const visibleText = String(body.visibleText ?? "");
    if (visibleText.length > 30000) throw new Error("SNAPSHOT_VISIBLE_TEXT_TOO_LARGE");
    const capturedAt = Number.isNaN(Date.parse(body.capturedAt)) ? new Date().toISOString() : new Date(body.capturedAt).toISOString();
    const { bridgeTask: _omittedBridgeTask, ...snapshotBody } = body;
    const runtime = await runtimeState();
    const incomingTask = bridgeTask?.taskId ? (runtime.browserTasks ?? []).find((task) => task.taskId === bridgeTask.taskId) : null;
    const incomingRun = incomingTask?.context?.runKind === "KEYWORD" ? (runtime.keywordRuns ?? []).find((run) => run.runId === incomingTask.context.runId) : null;
    const previousIds = new Set(incomingRun?.admittedNoteIds ?? []);
    const remaining = incomingRun ? Math.max(0, Number(incomingRun.settings.searchLimit) - previousIds.size) : Infinity;
    const admittedCards = incomingRun && Array.isArray(snapshotBody.cards)
      ? snapshotBody.cards.filter((card) => {
          if (!card?.noteId || previousIds.has(card.noteId)) return false;
          previousIds.add(card.noteId);
          return true;
        }).slice(0, remaining)
      : snapshotBody.cards;
    const safeSnapshot = { ...snapshotBody, cards: admittedCards, sourceUrl: source.href, capturedAt, visibleText, receivedAt: new Date().toISOString() };
    const fingerprint = createHash("sha256").update(JSON.stringify(safeSnapshot), "utf8").digest("hex");
    const receiptId = `browser-${Date.now()}-${fingerprint.slice(0, 10)}`;
    await mkdir(browserSnapshotRoot, { recursive: true });
    const snapshotPath = path.join(browserSnapshotRoot, `${receiptId}.json`);
    await writeJson(snapshotPath, { receiptId, fingerprint, snapshot: safeSnapshot });
    const fieldValidation = validateBrowserSnapshotFields(safeSnapshot, { receiptId, fingerprint, createdAt: safeSnapshot.receivedAt });
    await mkdir(browserFieldValidationRoot, { recursive: true });
    const fieldValidationPath = path.join(browserFieldValidationRoot, `${receiptId}.json`);
    await writeJson(fieldValidationPath, fieldValidation);
    const snapshotRelativePath = path.relative(projectRoot, snapshotPath);
    let taskResult = null;
    let ingestion = null;
    let ingestionError = null;
    // Comment traversal is supplementary evidence. A visible note detail remains
    // eligible so likes/saves/shares can enter the evidence store immediately.
    let captureEligible = body.status === "VISIBLE" && ["SEARCH", "NOTE_DETAIL"].includes(body.pageType);
    if (bridgeTask?.taskId && bridgeTask?.leaseToken) {
      const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
      const now = new Date().toISOString();
      const leased = queue.list().find((task) => task.taskId === bridgeTask.taskId);
      if (!leased) throw new Error("BROWSER_TASK_NOT_FOUND");
      const targetMatches = matchesBrowserTaskTarget(leased, source.href, safeSnapshot);
      if (body.status === "HUMAN_REQUIRED") taskResult = queue.fail(leased.taskId, bridgeTask.leaseToken, { category: "NEEDS_HUMAN", code: "BROWSER_HUMAN_REQUIRED", message: "The visible page requires login or verification." }, now);
      else if (body.status !== "VISIBLE" || body.pageType !== leased.expectedPageType || !targetMatches) {
        captureEligible = false;
        taskResult = queue.fail(leased.taskId, bridgeTask.leaseToken, { category: "PERMANENT", code: "BROWSER_TASK_PAGE_MISMATCH", message: "The visible page does not match the leased browser task." }, now);
      }
      if (captureEligible && body.testFixture !== true) {
        try {
          ingestion = await ingestBrowserSnapshot({ receipt: { receiptId, fingerprint, snapshotPath: snapshotRelativePath, snapshot: safeSnapshot }, databasePath: browserEvidenceDatabasePath, ingestedAt: now });
        } catch (error) {
          ingestionError = error instanceof Error ? error.message : "BROWSER_SNAPSHOT_INGESTION_FAILED";
          taskResult = queue.fail(leased.taskId, bridgeTask.leaseToken, { category: "RETRYABLE", code: "BROWSER_SNAPSHOT_INGESTION_FAILED", message: ingestionError }, now);
        }
      }
      if (captureEligible && body.testFixture === true) ingestion = { receiptId, status: "CONTRACT_TEST_ONLY", gaps: ["TEST_FIXTURE_NOT_WRITTEN_TO_LIVE_EVIDENCE_DATABASE"] };
      if (captureEligible && !taskResult) taskResult = queue.complete(leased.taskId, bridgeTask.leaseToken, receiptId, now);
      if (taskResult?.status === "SUCCEEDED" && leased.expectedPageType === "SEARCH" && leased.context?.runId) {
        const run = (runtime.keywordRuns ?? []).find((item) => item.runId === leased.context.runId);
        if (run) {
          if (Array.isArray(ingestion?.rankingSnapshotIds) && ingestion.rankingSnapshotIds.length) {
            run.admittedNoteIds = [...new Set([...(run.admittedNoteIds ?? []), ...(safeSnapshot.cards ?? []).map((card) => card.noteId).filter(Boolean)])];
            run.counters.admittedCards = run.admittedNoteIds.length;
            run.counters.discoveredCandidates = Number(run.counters.discoveredCandidates ?? 0) + Number(safeSnapshot.searchTraversal?.candidateCount ?? safeSnapshot.cards?.length ?? 0);
          }
          const quotaReached = Number(run.counters.admittedCards ?? 0) >= Number(run.settings.searchLimit);
          const expansionTasks = quotaReached ? [] : createExpansionTasks(run, leased, Array.isArray(safeSnapshot.suggestions) ? safeSnapshot.suggestions : []);
          for (const input of expansionTasks) queue.enqueue(input, now);
          if (quotaReached) queue.finishQueuedByRun(run.runId, now);
          const detailTasks = createDetailTasks(run, leased, Array.isArray(safeSnapshot.cards) ? safeSnapshot.cards : []);
          const keyword = run.keywords.find((item) => item.keywordId === leased.context.keywordId);
          for (const input of detailTasks) {
            const detail = queue.enqueue(input, now);
            if (keyword && !keyword.detailTaskIds.includes(detail.taskId)) keyword.detailTaskIds.push(detail.taskId);
          }
        }
        const rankingRun = (runtime.rankingRuns ?? []).find((item) => item.runId === leased.context.runId);
        if (rankingRun) {
          const cards = Array.isArray(safeSnapshot.cards) ? safeSnapshot.cards : [];
          rankingRun.counters.discoveredCandidates = Number(safeSnapshot.searchTraversal?.candidateCount ?? cards.length);
          rankingRun.counters.ingestedCandidates = Array.isArray(ingestion?.rankingSnapshotIds) && ingestion.rankingSnapshotIds.length ? cards.length : 0;
          if (ingestion?.enrichmentTargets?.length || (rankingRun.settings.completeMetrics && ingestion?.rankingSnapshotIds?.length)) {
            const planId = ingestion.enrichmentTargets?.[0]?.planId ?? `metrics-${rankingRun.runId}`;
            const plan = { planId, tasks: (ingestion.enrichmentTargets ?? []).filter((item) => item.planId === planId) };
            for (const input of createRankingEnrichmentTasks(rankingRun, leased, plan, cards)) queue.enqueue(input, now);
          }
        }
      }
      if (taskResult?.status === "SUCCEEDED" && leased.expectedPageType === "NOTE_DETAIL" && body.testFixture !== true && !ingestionError) {
        const run = [...(runtime.keywordRuns ?? []), ...(runtime.rankingRuns ?? [])].find(item => item.runId === leased.context?.runId);
        if (run?.settings.completeMetrics && leased.context.noteId) {
          run.metricGaps ??= {};
          run.metricGaps[leased.context.noteId] = ["likes", "collects", "shares"].filter(key => typeof safeSnapshot.metrics?.[key] !== "number" || !Number.isFinite(safeSnapshot.metrics[key]) || safeSnapshot.metrics[key] < 0);
        }
      }
      if (taskResult?.status === "SUCCEEDED" && leased.expectedPageType === "NOTE_DETAIL" && ["RANKING", "GAP_REFILL"].includes(leased.context?.runKind) && leased.context?.runId) {
        const rankingRun = (runtime.rankingRuns ?? []).find((item) => item.runId === leased.context.runId);
        if (rankingRun && leased.context.noteId) {
          const decisionGaps = [...new Set([...(ingestion?.gaps ?? []), ...(fieldValidation.gaps ?? [])])]
            .filter((gap) => rankingRun.settings.completeMetrics ? ["DETAIL_LIKES_MISSING", "DETAIL_COLLECTS_MISSING", "DETAIL_SHARES_MISSING"].includes(gap) : !String(gap).startsWith("COMMENT_"));
          updateRankingTargetGaps(
            rankingRun,
            leased.context.noteId,
            decisionGaps,
            leased.taskId,
            now,
          );
          for (const input of createRankingGapRefillTasks(rankingRun, leased, now)) queue.enqueue(input, now);
        }
      }
      runtime.browserTasks = queue.list();
      reconcileKeywordRuns(runtime, now);
      reconcileRankingRuns(runtime, now);
    } else if (captureEligible) {
      if (body.testFixture === true) {
        ingestion = { receiptId, status: "CONTRACT_TEST_ONLY", gaps: ["TEST_FIXTURE_NOT_WRITTEN_TO_LIVE_EVIDENCE_DATABASE"] };
      } else {
        try {
          ingestion = await ingestBrowserSnapshot({ receipt: { receiptId, fingerprint, snapshotPath: snapshotRelativePath, snapshot: safeSnapshot }, databasePath: browserEvidenceDatabasePath, ingestedAt: new Date().toISOString() });
        } catch (error) { ingestionError = error instanceof Error ? error.message : "BROWSER_SNAPSHOT_INGESTION_FAILED"; }
      }
    }
    runtime.browserBridge = {
      ...(runtime.browserBridge ?? {}),
      status: body.testFixture === true ? "CONTRACT_TEST_ONLY" : ingestionError ? "INGESTION_FAILED" : "CONNECTED",
      evidenceDatabasePath: path.relative(projectRoot, browserEvidenceDatabasePath),
      lastSnapshot: { receiptId, sourceUrl: source.href, pageType: body.pageType, status: body.status, capturedAt, receivedAt: safeSnapshot.receivedAt, snapshotPath: snapshotRelativePath, testFixture: body.testFixture === true, ingestion, ingestionError, fieldValidation },
      lastFieldValidation: { ...fieldValidation, reportPath: path.relative(projectRoot, fieldValidationPath) },
    };
    runtime.updatedAt = new Date().toISOString();
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 202, { receiptId, fingerprint, status: captureEligible && !ingestionError ? "ACCEPTED" : "QUARANTINED", snapshotPath: snapshotRelativePath, fieldValidation, ingestion, ingestionError, task: taskResult });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/browser-bridge/database") {
    try {
      await stat(browserEvidenceDatabasePath);
      const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
      try { sendJson(response, 200, await store.exportDocument()); } finally { store.close(); }
    }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      sendJson(response, 200, { storeVersion: "sqlite-2", rawEnvelopes: [], notes: [], qualityDecisions: [], rankingLedgers: [], completenessLedgers: [], enrichmentPlans: [], savedViews: [] });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes/enrich") {
    const body = await parseBody(request);
    const noteId = String(body.noteId ?? "").trim().slice(0, 160);
    if (!noteId) throw new Error("NOTE_ID_REQUIRED");
    const runtime = await runtimeState();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    const now = new Date().toISOString();
    const task = queue.enqueue({ sourceId: "manual-metric-refill", targetUrl: String(body.sourceUrl ?? ""), expectedPageType: "NOTE_DETAIL", priority: 85, maxAttempts: 3, context: { noteId, collectNotes: true, autoCollectNotes: false, stages: ["DETAIL"] } }, now);
    runtime.browserTasks = queue.list(); runtime.updatedAt = now;
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 202, { taskId: task.taskId, status: task.status }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    const [runtime, providers] = await Promise.all([runtimeState(), readProviderConfig()]);
    const browserTasks = runtime.browserTasks ?? [];
    const taskById = new Map(browserTasks.map((task) => [task.taskId, task]));
    const dispatchHistory = (runtime.rankingDispatchHistory ?? []).map((item) => ({ ...item, taskStatus: taskById.get(item.browserTaskId)?.status ?? "UNKNOWN", receiptId: taskById.get(item.browserTaskId)?.receiptId ?? null, error: taskById.get(item.browserTaskId)?.error ?? null }));
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    const realCollector = realCollectorState ?? runtime.realCollector ?? null;
    const realPlatformAdapter = realCollector?.status === "SUCCEEDED" ? "OPENCLI_LOGGED_IN_ADMITTED_SEARCH_DETAIL_COMMENTS_VALIDATED"
      : realCollector?.status === "PARTIAL" ? "OPENCLI_LOGGED_IN_SEARCH_VALIDATED_DETAIL_PARTIAL"
        : "OPENCLI_LOGGED_IN_READY";
    sendJson(response, 200, { server: "RUNNING", dataMode: runtime.dataMode, realPlatformAdapter, realCollector, browserBridge: summarizeBrowserBridge(runtime), browserTasks, keywordRuns: runtime.keywordRuns ?? [], rankingRuns: runtime.rankingRuns ?? [], collectionProgress: currentCollectionProgress(runtime), researchActive: researchExecutionActive, researchRuns: (runtime.researchRuns ?? []).map(publicResearchSummary), startupRecoveryHistory: runtime.startupRecoveryHistory ?? [], collectionActive, collectionJob: collectionJob ? { ...collectionJob, abortController: undefined } : null, collectionHistory: runtime.collectionHistory ?? [], rankingMonitor: { ...runtime.rankingMonitor, running: monitor?.isRunning() ?? false, captureActive: monitor?.isCaptureActive() ?? false, schedule: monitor?.getSchedule() ?? runtime.rankingMonitorSchedule ?? null, receipts: monitor?.listReceipts() ?? [], dispatchHistory }, providers: providers.providers.map((provider) => publicProviderState(provider)), generatedAt: new Date().toISOString() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/runtime-summary") {
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    const activeStatuses = ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"];
    const keywordRun = (runtime.keywordRuns ?? []).find((run) => activeStatuses.includes(run.status)) ?? (runtime.keywordRuns ?? [])[0] ?? null;
    const rankingRun = (runtime.rankingRuns ?? []).find((run) => activeStatuses.includes(run.status)) ?? (runtime.rankingRuns ?? [])[0] ?? null;
    const relevantRunIds = new Set([keywordRun?.runId, rankingRun?.runId].filter(Boolean));
    const browserTasks = (runtime.browserTasks ?? []).filter((task) => relevantRunIds.has(task.context?.runId)).slice(-300);
    sendJson(response, 200, {
      server: "RUNNING",
      realCollector: realCollectorState ?? runtime.realCollector ?? null,
      browserBridge: summarizeBrowserBridge(runtime),
      browserTasks,
      keywordRuns: keywordRun ? [keywordRun] : [],
      rankingRuns: rankingRun ? [rankingRun] : [],
      collectionProgress: currentCollectionProgress(runtime),
      researchRuns: (runtime.researchRuns ?? []).slice(0, 1).map(publicResearchSummary),
      rankingMonitor: { ...runtime.rankingMonitor, running: monitor?.isRunning() ?? false, captureActive: monitor?.isCaptureActive() ?? false, schedule: monitor?.getSchedule() ?? runtime.rankingMonitorSchedule ?? null },
      generatedAt: new Date().toISOString(),
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/collection/progress") {
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    sendJson(response, 200, currentCollectionProgress(runtime)); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/workbench-presence") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    const now = new Date().toISOString();
    const previous = runtime.workbenchPresence ?? {};
    const active = body.active === true;
    runtime.workbenchPresence = { ...previous, lastSeenAt: active ? now : previous.lastSeenAt, activeUntil: active ? new Date(Date.now() + 30 * 60_000).toISOString() : now };
    let outcome = "IDLE";
    const lastTriggered = Date.parse(previous.lastTriggeredAt ?? "") || 0;
    const due = active && Date.now() - lastTriggered >= 60 * 60_000;
    if (due && runtime.rankingMonitor?.mode === "REAL_ADAPTER" && runtime.rankingMonitor?.targetUrl && runtime.rankingMonitor?.collectorKind === "EXTENSION") {
      runtime.workbenchPresence.lastTriggeredAt = now;
      outcome = "DISPATCHED";
    } else if (due) outcome = "WAITING_FOR_SEARCH_PAGE";
    runtime.updatedAt = now; await writeJson(runtimeStatePath, runtime);
    if (outcome === "DISPATCHED") {
      const receipt = await monitor.run("MANUAL");
      outcome = receipt.status;
    }
    sendJson(response, 200, { outcome, nextDueAt: runtime.workbenchPresence.lastTriggeredAt ? new Date(Date.parse(runtime.workbenchPresence.lastTriggeredAt) + 60 * 60_000).toISOString() : null }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/research-runs") {
    const runtime = await runtimeState();
    sendJson(response, 200, { active: publicResearchSummary((runtime.researchRuns ?? []).find(isResearchRunActive) ?? null), runs: (runtime.researchRuns ?? []).map(publicResearchSummary) });
    return true;
  }
  if (request.method === "GET" && /^\/api\/research-runs\/[^/]+$/.test(url.pathname)) {
    const runId = decodeURIComponent(url.pathname.split("/").at(-1));
    const runtime = await runtimeState();
    const run = (runtime.researchRuns ?? []).find((item) => item.runId === runId);
    if (!run) throw new Error("RESEARCH_RUN_NOT_FOUND");
    sendJson(response, 200, publicResearchRun(run));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/research-export") {
    const runtime = await runtimeState();
    const runId = String(url.searchParams.get("runId") ?? "");
    const run = (runtime.researchRuns ?? []).find((item) => item.runId === runId) ?? (runtime.researchRuns ?? [])[0];
    if (!run) throw new Error("RESEARCH_RUN_NOT_FOUND");
    const format = String(url.searchParams.get("format") ?? "json").toLowerCase();
    const baseName = `xiaohongshu-research-${run.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (format === "json") {
      sendDownload(response, "application/json; charset=utf-8", `${baseName}.json`, `${JSON.stringify(publicResearchRun(run), null, 2)}\n`);
      return true;
    }
    if (format === "csv") {
      const header = ["关键词", "层级", "状态", "候选卡片", "尝试详情", "完整入库", "抓取评论", "保留高价值评论", "完整性拒绝"];
      const rows = (run.queue ?? []).map((item) => [item.value, item.depth, item.status, item.cardCount, item.attemptedNotes, item.savedNotes, item.fetchedComments, item.retainedComments, item.rejectedNotes]);
      sendDownload(response, "text/csv; charset=utf-8", `${baseName}.csv`, `\uFEFF${[header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n")}\r\n`);
      return true;
    }
    if (format === "md") {
      const opportunities = run.insights?.keywordOpportunities ?? [];
      const accounts = run.insights?.competitorAccounts ?? [];
      const body = [
        `# 小红书爆款采集分析`, "",
        `- 任务：${escapeMarkdown(run.runId)}`,
        `- 状态：${escapeMarkdown(run.status)}`,
        `- 完整入库：${run.counters?.savedNotes ?? 0} 条`,
        `- 高价值评论：${run.counters?.retainedComments ?? 0} 条`, "",
        "## 关键词机会", "",
        "| 关键词 | 候选 | 完整入库 | 高价值评论 |", "| --- | ---: | ---: | ---: |",
        ...opportunities.map((item) => `| ${escapeMarkdown(item.keyword)} | ${item.cardCount} | ${item.savedNotes} | ${item.retainedComments} |`), "",
        "## 反复出现的账号", "",
        "| 账号 | 出现次数 | 累计点赞 | 涉及关键词 |", "| --- | ---: | ---: | --- |",
        ...accounts.map((item) => `| ${escapeMarkdown(item.authorName)} | ${item.appearances} | ${item.totalLikes} | ${escapeMarkdown(item.keywords.join("、"))} |`), "",
      ].join("\n");
      sendDownload(response, "text/markdown; charset=utf-8", `${baseName}.md`, body);
      return true;
    }
    throw new Error("INVALID_RESEARCH_EXPORT_FORMAT");
  }
  if (request.method === "POST" && url.pathname === "/api/research-runs") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    if ((runtime.researchRuns ?? []).some(isResearchRunActive)) throw new Error("RESEARCH_RUN_ALREADY_ACTIVE");
    const run = createRealKeywordResearchRun({ seeds: body.seeds, settings: body.settings, now: new Date().toISOString() });
    researchControls.set(run.runId, { ...run.control });
    await persistResearchRun(run);
    setImmediate(() => executeResearchRun(run.runId));
    sendJson(response, 202, publicResearchRun(run));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/research-runs/control") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    const run = (runtime.researchRuns ?? []).find((item) => item.runId === body.runId) ?? (runtime.researchRuns ?? []).find(isResearchRunActive);
    if (!run) throw new Error("NO_ACTIVE_RESEARCH_RUN");
    const action = String(body.action ?? "").toUpperCase();
    const control = researchControls.get(run.runId) ?? run.control ?? { pauseRequested: false, cancelRequested: false };
    if (action === "PAUSE" && isResearchRunActive(run)) {
      control.pauseRequested = true;
      run.phase = "正在收尾当前关键词，随后暂停";
    } else if (action === "RESUME" && run.status === "PAUSED") {
      control.pauseRequested = false;
      run.status = "QUEUED";
      run.phase = "准备继续";
    } else if (action === "CANCEL" && isResearchRunActive(run)) {
      control.cancelRequested = true;
      control.pauseRequested = false;
      run.status = "CANCEL_REQUESTED";
      run.phase = "正在收尾当前关键词，随后停止";
    } else throw new Error("INVALID_RESEARCH_RUN_CONTROL");
    run.control = { ...control };
    run.updatedAt = new Date().toISOString();
    researchControls.set(run.runId, control);
    await persistResearchRun(run);
    if (action === "RESUME") setImmediate(() => executeResearchRun(run.runId));
    sendJson(response, 200, publicResearchRun(run));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/report") { sendJson(response, 200, await readJson(reportPath)); return true; }
  if (request.method === "GET" && url.pathname === "/api/database") { sendJson(response, 200, await readJson(databasePath)); return true; }
  if (request.method === "GET" && url.pathname === "/api/connections") {
    const runtime = await runtimeState();
    const connections = runtime.connections ?? { matrixAccounts: [], feishu: { enabled: false, webhookEnv: "FEISHU_WEBHOOK_URL" } };
    sendJson(response, 200, { ...connections, feishu: { ...connections.feishu, configured: Boolean(process.env[connections.feishu.webhookEnv]) } }); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/connections/matrix") {
    const body = await parseBody(request);
    if (!Array.isArray(body.accounts)) throw new Error("INVALID_MATRIX_ACCOUNTS");
    const ids = new Set();
    const accounts = body.accounts.map((item) => {
      const accountId = String(item.accountId ?? "").trim(); const label = String(item.label ?? "").trim();
      if (!accountId || !label || ids.has(accountId)) throw new Error("INVALID_OR_DUPLICATE_MATRIX_ACCOUNT");
      ids.add(accountId); return { accountId, label, enabled: item.enabled === true, profileHint: String(item.profileHint ?? "").trim() };
    });
    const runtime = await runtimeState(); runtime.connections ??= {}; runtime.connections.matrixAccounts = accounts; runtime.connections.feishu ??= { enabled: false, webhookEnv: "FEISHU_WEBHOOK_URL" }; runtime.updatedAt = new Date().toISOString(); await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { accounts }); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/connections/feishu") {
    const body = await parseBody(request); const webhookEnv = String(body.webhookEnv ?? "").trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(webhookEnv)) throw new Error("INVALID_WEBHOOK_ENV");
    const runtime = await runtimeState(); runtime.connections ??= {}; runtime.connections.matrixAccounts ??= []; runtime.connections.feishu = { enabled: body.enabled === true, webhookEnv }; runtime.updatedAt = new Date().toISOString(); await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { ...runtime.connections.feishu, configured: Boolean(process.env[webhookEnv]) }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/connections/feishu/sync") {
    const body = await parseBody(request); requireExternalConfirmation(body);
    const runtime = await runtimeState(); const config = runtime.connections?.feishu;
    if (!config?.enabled) throw new Error("FEISHU_SYNC_DISABLED");
    const webhook = process.env[config.webhookEnv]; if (!webhook) throw new Error("FEISHU_WEBHOOK_NOT_CONFIGURED");
    const report = await readJson(reportPath); const eligible = report.assessments.filter((item) => item.status === "ELIGIBLE");
    const text = `小红书内容情报台同步：${eligible.length} 条可解读候选，${report.assessments.length - eligible.length} 条证据阻断。生成时间：${new Date().toISOString()}`;
    const result = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg_type: "text", content: { text } }) });
    if (!result.ok) throw new Error(`FEISHU_HTTP_${result.status}`);
    sendJson(response, 200, { status: "SUCCEEDED", syncedAt: new Date().toISOString(), candidateCount: eligible.length }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/providers") {
    const config = await readProviderConfig();
    sendJson(response, 200, { ...config, providers: config.providers.map(publicProvider) }); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/model-api-mode") {
    const body = await parseBody(request);
    if (typeof body.enabled !== "boolean") throw new Error("INVALID_MODEL_API_MODE");
    const settings = await readCurrentModelSettings();
    settings.apiEnabled = body.enabled;
    await writeJson(modelSettingsPath, settings);
    sendJson(response, 200, { apiEnabled: settings.apiEnabled }); return true;
  }
  if (request.method === "PUT" && /^\/api\/providers\/[^/]+$/.test(url.pathname)) {
    const providerId = decodeURIComponent(url.pathname.split("/").at(-1));
    const body = await parseBody(request);
    const config = await readJson(providerConfigPath);
    const settings = await readCurrentModelSettings();
    const index = config.providers.findIndex((provider) => provider.providerId === providerId);
    if (index < 0) throw new Error("PROVIDER_NOT_FOUND");
    const previous = config.providers[index];
    const previousUrl = settings.providers[providerId]?.baseUrl ?? previous.baseUrl;
    const next = { ...previous, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() : previousUrl, enabled: body.enabled === true };
    const parsed = new URL(next.baseUrl);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) throw new Error("INSECURE_PROVIDER_URL");
    const newKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const saved = { ...(settings.providers[providerId] ?? {}), baseUrl: next.baseUrl };
    if (newKey) { saved.encryptedKey = await transformSecret(modelSecretScriptPath, "Protect", newKey); saved.cleared = false; }
    settings.providers[providerId] = saved;
    await writeJson(modelSettingsPath, settings);
    if (newKey) process.env[next.apiKeyEnv] = newKey;
    if (next.baseUrl !== previousUrl || newKey) providerVerification.delete(providerId);
    if (next.enabled) config.providers = config.providers.map((provider) => ({ ...provider, enabled: provider.providerId === providerId }));
    config.providers[index] = { ...config.providers[index], enabled: next.enabled };
    await writeJson(providerConfigPath, config);
    sendJson(response, 200, publicProvider(next)); return true;
  }
  if (request.method === "DELETE" && /^\/api\/providers\/[^/]+\/credentials$/.test(url.pathname)) {
    const providerId = decodeURIComponent(url.pathname.split("/")[3]);
    const config = await readJson(providerConfigPath);
    const provider = config.providers.find((item) => item.providerId === providerId);
    if (!provider) throw new Error("PROVIDER_NOT_FOUND");
    const settings = await readCurrentModelSettings();
    settings.providers[providerId] = { baseUrl: "", encryptedKey: null, cleared: true };
    settings.apiEnabled = false;
    await writeJson(modelSettingsPath, settings);
    delete process.env[provider.apiKeyEnv];
    providerVerification.delete(providerId);
    config.routes = config.routes.map((route) => route.providerId === providerId ? { ...route, providerId: "", modelId: "" } : route);
    await writeJson(providerConfigPath, config);
    sendJson(response, 200, { providerId, cleared: true }); return true;
  }
  if (request.method === "POST" && /^\/api\/providers\/[^/]+\/models$/.test(url.pathname)) {
    const providerId = decodeURIComponent(url.pathname.split("/")[3]);
    const body = await parseBody(request);
    requireExternalConfirmation(body);
    await requireModelApiEnabled();
    const config = await readProviderConfig();
    const provider = config.providers.find((item) => item.providerId === providerId);
    if (!provider) throw new Error("PROVIDER_NOT_FOUND");
    const models = await gateway.listModels(provider);
    const verification = { verified: true, verifiedAt: new Date().toISOString(), modelCount: models.length };
    providerVerification.set(providerId, verification);
    sendJson(response, 200, { providerId, models, ...verification }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/project-state") {
    const projectState = await readJson(projectStatePath);
    sendJson(response, 200, { direction: projectState.direction, product: { name: projectState.product?.name, status: projectState.product?.status } }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/market-state") {
    sendJson(response, 200, await readMarketState()); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/market-state/direction") {
    const body = await parseBody(request);
    const direction = String(body.direction ?? "").trim().slice(0, 300);
    const preciseTerms = [...new Set((Array.isArray(body.preciseTerms) ? body.preciseTerms : []).map((term) => String(term).trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
    const market = await readMarketState();
    if (market.direction && market.direction !== direction) {
      market.archives = [{ direction: market.direction, preciseTerms: market.preciseTerms ?? [], archivedAt: new Date().toISOString() }, ...(market.archives ?? [])].slice(0, 50);
      const runtime = await runtimeState();
      const now = new Date().toISOString();
      const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
      for (const run of runtime.keywordRuns ?? []) {
        if (!["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status)) continue;
        run.status = "CANCEL_REQUESTED";
        queue.cancelByRun(run.runId, now);
      }
      for (const run of runtime.rankingRuns ?? []) {
        if (!["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status)) continue;
        run.status = "CANCEL_REQUESTED";
        queue.cancelByRun(run.runId, now);
      }
      runtime.browserTasks = queue.list();
      reconcileKeywordRuns(runtime);
      reconcileRankingRuns(runtime);
      runtime.rankingMonitor = { ...(runtime.rankingMonitor ?? {}), enabled: false, targetUrl: null };
      runtime.updatedAt = now;
      await writeJson(runtimeStatePath, runtime);
      await rebuildMonitor();
    }
    market.direction = direction; market.preciseTerms = preciseTerms; market.updatedAt = new Date().toISOString();
    await writeJson(marketStatePath, market);
    sendJson(response, 200, market); return true;
  }
  if (request.method === "DELETE" && /^\/api\/market-state\/archives\/\d+$/.test(url.pathname)) {
    const market = await readMarketState();
    const index = Number(url.pathname.split("/").at(-1));
    if (index < 0 || index >= (market.archives ?? []).length) throw new Error("MARKET_ARCHIVE_NOT_FOUND");
    market.archives.splice(index, 1); market.updatedAt = new Date().toISOString();
    await writeJson(marketStatePath, market); sendJson(response, 200, market); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/market-state/favorites") {
    const body = await parseBody(request);
    const noteId = String(body.noteId ?? "").trim().slice(0, 160);
    const sourceUrl = String(body.sourceUrl ?? "").trim();
    if (!noteId || !/^https:\/\/(www\.)?xiaohongshu\.com\//i.test(sourceUrl)) throw new Error("INVALID_FAVORITE_POST");
    const market = await readMarketState();
    market.favorites = [{ noteId, title: String(body.title ?? "").trim().slice(0, 300), sourceUrl, direction: String(body.direction ?? market.direction ?? "全站").trim().slice(0, 300) || "全站", savedAt: new Date().toISOString() }, ...(market.favorites ?? []).filter((item) => item.noteId !== noteId)].slice(0, 2000);
    market.updatedAt = new Date().toISOString(); await writeJson(marketStatePath, market);
    sendJson(response, 200, market); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/market-state/favorites/delete") {
    const body = await parseBody(request);
    const ids = new Set((Array.isArray(body.noteIds) ? body.noteIds : []).map(String));
    const market = await readMarketState();
    market.favorites = (market.favorites ?? []).filter((item) => !ids.has(item.noteId));
    market.updatedAt = new Date().toISOString(); await writeJson(marketStatePath, market);
    sendJson(response, 200, market); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/view-history") {
    const history = await readViewHistory();
    const query = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
    const sourceView = String(url.searchParams.get("sourceView") ?? "").trim();
    const selected = String(url.searchParams.get("selected") ?? "").trim();
    const entries = history.entries.filter((entry) => (!query || `${entry.title} ${entry.author ?? ""} ${entry.sector ?? ""}`.toLowerCase().includes(query)) && (!sourceView || entry.sourceView === sourceView) && (!selected || String(entry.selected === true) === selected)).sort((a, b) => Date.parse(b.lastViewedAt) - Date.parse(a.lastViewedAt));
    sendJson(response, 200, { ...history, entries }); return true;
  }
  if (request.method === "DELETE" && url.pathname === "/api/view-history") {
    const history = await readViewHistory();
    const deletedCount = history.entries.length;
    history.entries = [];
    history.updatedAt = new Date().toISOString();
    await writeJson(viewHistoryPath, history);
    sendJson(response, 200, { deletedCount, entries: [] }); return true;
  }
  const viewHistoryDeleteMatch = url.pathname.match(/^\/api\/view-history\/([^/]+)$/);
  if (request.method === "DELETE" && viewHistoryDeleteMatch) {
    const noteId = decodeURIComponent(viewHistoryDeleteMatch[1]);
    const history = await readViewHistory();
    const before = history.entries.length;
    history.entries = history.entries.filter((entry) => entry.noteId !== noteId);
    if (history.entries.length === before) { sendJson(response, 404, { error: "VIEW_HISTORY_NOTE_NOT_FOUND" }); return true; }
    history.updatedAt = new Date().toISOString();
    await writeJson(viewHistoryPath, history);
    sendJson(response, 200, { noteId, deleted: history.entries.length < before }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/view-history") {
    const body = await parseBody(request);
    const noteId = String(body.noteId ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!noteId || !title) throw new Error("VIEW_HISTORY_NOTE_REQUIRED");
    const history = await readViewHistory();
    const now = new Date().toISOString();
    const existing = history.entries.find((entry) => entry.noteId === noteId);
    const incomingSourceView = String(body.sourceView ?? "ranking");
    const sourceView = existing && ["history", "detail"].includes(incomingSourceView) ? existing.sourceView : incomingSourceView;
    const entry = { ...(existing ?? {}), noteId, title, author: String(body.author ?? ""), sector: String(body.sector ?? ""), sourceView, sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : existing?.sourceUrl ?? null, selected: body.selected === true || existing?.selected === true, firstViewedAt: existing?.firstViewedAt ?? now, lastViewedAt: now, viewCount: (existing?.viewCount ?? 0) + 1 };
    history.entries = [entry, ...history.entries.filter((item) => item.noteId !== noteId)].slice(0, 1000);
    history.updatedAt = now;
    await writeJson(viewHistoryPath, history);
    sendJson(response, 200, entry); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/model-routes") {
    const body = await parseBody(request);
    const config = await readJson(providerConfigPath);
    if (!Array.isArray(body.routes)) throw new Error("INVALID_MODEL_ROUTES");
    const tasks = new Set(config.routes.map((route) => route.task));
    if (body.routes.some((route) => !tasks.has(route.task))) throw new Error("INVALID_MODEL_TASK");
    config.routes = body.routes.map((route) => ({ task: route.task, providerId: String(route.providerId ?? ""), modelId: String(route.modelId ?? ""), fallbackProviderIds: Array.isArray(route.fallbackProviderIds) ? route.fallbackProviderIds.map(String) : [] }));
    await writeJson(providerConfigPath, config);
    sendJson(response, 200, { routes: config.routes }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/model/analyze") {
    const body = await parseBody(request);
    requireExternalConfirmation(body);
    await requireModelApiEnabled();
    const config = await readProviderConfig();
    const provider = config.providers.find((item) => item.providerId === body.providerId);
    if (!provider) throw new Error("PROVIDER_NOT_FOUND");
    sendJson(response, 200, await gateway.analyze({ config: provider, task: body.task, modelId: body.modelId, systemPrompt: body.systemPrompt, evidencePacket: body.evidencePacket, requireJson: body.requireJson === true })); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/ranking/config") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    const intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error("INVALID_MONITOR_INTERVAL");
    const mode = body.mode === "REAL_ADAPTER" ? "REAL_ADAPTER" : "OFFLINE_FIXTURE";
    const targetUrl = String(body.targetUrl ?? "").trim();
    if (mode === "REAL_ADAPTER") {
      let parsed;
      try { parsed = new URL(targetUrl); } catch { throw new Error("INVALID_RANKING_TARGET_URL"); }
      if (parsed.protocol !== "https:" || !/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) throw new Error("RANKING_TARGET_NOT_ALLOWED");
    }
    const maxDetailTargets = Number(body.maxDetailTargets ?? runtime.rankingMonitor?.maxDetailTargets ?? 0);
    const maxRefillRounds = Number(body.maxRefillRounds ?? runtime.rankingMonitor?.maxRefillRounds ?? 2);
    const requestIntervalMs = Number(body.requestIntervalMs ?? runtime.rankingMonitor?.requestIntervalMs ?? 8000);
    const slowNetworkMaxWaitMs = Number(body.slowNetworkMaxWaitMs ?? runtime.rankingMonitor?.slowNetworkMaxWaitMs ?? 300000);
    if (!Number.isInteger(maxDetailTargets) || maxDetailTargets < 0 || maxDetailTargets > 200) throw new Error("INVALID_RANKING_DETAIL_BUDGET");
    if (!Number.isInteger(maxRefillRounds) || maxRefillRounds < 0 || maxRefillRounds > 5) throw new Error("INVALID_RANKING_REFILL_BUDGET");
    if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 300000) throw new Error("INVALID_RANKING_REQUEST_INTERVAL");
    if (!Number.isInteger(slowNetworkMaxWaitMs) || slowNetworkMaxWaitMs < 5000 || slowNetworkMaxWaitMs > 600000) throw new Error("INVALID_RANKING_WAIT_BUDGET");
    const autoArmSuppressed = body.autoArmSuppressed === undefined ? runtime.rankingMonitor?.autoArmSuppressed === true : body.autoArmSuppressed === true;
    const collectorKind = body.collectorKind === "EXTENSION" ? "EXTENSION" : "OPENCLI";
    const opencliProfile = String(body.opencliProfile ?? runtime.rankingMonitor?.opencliProfile ?? "ufbrj4yc").trim();
    const searchLimit = Number(body.searchLimit ?? runtime.rankingMonitor?.searchLimit ?? 1500);
    const commentLimit = Number(body.commentLimit ?? runtime.rankingMonitor?.commentLimit ?? 50);
    if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 10000) throw new Error("INVALID_RANKING_SEARCH_LIMIT");
    if (!Number.isInteger(commentLimit) || commentLimit < 1 || commentLimit > 500) throw new Error("INVALID_RANKING_COMMENT_LIMIT");
    runtime.rankingMonitor = { enabled: body.enabled === true, autoArmSuppressed, intervalMinutes, scopeId: String(body.scopeId || "ranking:discovery:daily"), mode, targetUrl, collectorKind, opencliProfile, searchLimit, commentLimit, maxDetailTargets, maxRefillRounds, requestIntervalMs, slowNetworkMaxWaitMs };
    runtime.updatedAt = new Date().toISOString();
    await writeJson(runtimeStatePath, runtime);
    await rebuildMonitor();
    sendJson(response, 200, { ...runtime.rankingMonitor, running: monitor.isRunning() }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/ranking/refresh") {
    const receipt = await monitor.run("MANUAL");
    if (receipt.status !== "FAILED") {
      const runtime = await runtimeState();
      runtime.workbenchPresence = { ...(runtime.workbenchPresence ?? {}), lastTriggeredAt: new Date().toISOString() };
      await writeJson(runtimeStatePath, runtime);
    }
    sendJson(response, receipt.status === "FAILED" ? 409 : 200, receipt); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/ranking/run") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    reconcileRankingRuns(runtime);
    if ((runtime.rankingRuns ?? []).some((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status))) throw new Error("RANKING_RUN_ALREADY_ACTIVE");
    const config = runtime.rankingMonitor ?? {};
    const now = new Date().toISOString();
    const { run, task } = createRankingBrowserRun({
      monitorId: String(body.monitorId || "manual-ranking-validation"),
      scopeId: String(body.scopeId || config.scopeId || "ranking:manual"),
      targetUrl: String(body.targetUrl || config.targetUrl || ""),
      searchLimit: body.searchLimit ?? config.searchLimit ?? 1500,
      maxDetailTargets: body.maxDetailTargets ?? config.maxDetailTargets ?? 0,
      completeMetrics: true,
      maxRefillRounds: body.noRetry === true ? 0 : body.maxRefillRounds ?? config.maxRefillRounds ?? 0,
      requestIntervalMs: body.requestIntervalMs ?? config.requestIntervalMs ?? 8000,
      slowNetworkMaxWaitMs: body.slowNetworkMaxWaitMs ?? config.slowNetworkMaxWaitMs ?? 300000,
    }, now);
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    if (body.noRetry === true) task.maxAttempts = 1;
    queue.enqueue(task, now);
    runtime.browserTasks = queue.list();
    runtime.rankingRuns = [run, ...(runtime.rankingRuns ?? [])].slice(0, 50);
    runtime.updatedAt = now;
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 202, { run, dispatchedTasks: 1 });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/ranking/run") {
    const runtime = await runtimeState();
    reconcileRankingRuns(runtime);
    sendJson(response, 200, { runs: runtime.rankingRuns ?? [], active: (runtime.rankingRuns ?? []).find((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status)) ?? null }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/ranking/run/control") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    reconcileRankingRuns(runtime);
    const run = (runtime.rankingRuns ?? []).find((item) => item.runId === body.runId) ?? (runtime.rankingRuns ?? []).find((item) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(item.status));
    if (!run) throw new Error("NO_ACTIVE_RANKING_RUN");
    const action = String(body.action ?? ""); const now = new Date().toISOString();
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    if (action === "PAUSE" && ["QUEUED", "RUNNING"].includes(run.status)) run.status = "PAUSED";
    else if (action === "RESUME" && run.status === "PAUSED") run.status = "RUNNING";
    else if (action === "CANCEL" && ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED", "CANCELLED"].includes(run.status)) { if (run.status !== "CANCELLED") run.status = "CANCEL_REQUESTED"; queue.cancelByRun(run.runId, now); }
    else throw new Error("INVALID_RANKING_RUN_CONTROL");
    runtime.browserTasks = queue.list();
    Object.assign(run, reconcileRankingBrowserRun(run, runtime.browserTasks, now));
    runtime.updatedAt = now; await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { run }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/keywords/plan") {
    const body = await parseBody(request);
    const seeds = String(body.seeds ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const plan = buildKeywordPlan({ planId: `ui-plan-${Date.now()}`, taskId: `ui-task-${Date.now()}`, seedKeywords: seeds, expansions: Array.isArray(body.expansions) ? body.expansions : [], policy: { maxDepth: Number(body.maxDepth ?? 1), maxKeywords: Number(body.maxKeywords ?? 300), maxChildrenPerKeyword: Number(body.maxChildrenPerKeyword ?? 10), noteDetailsPerKeyword: Number(body.noteDetailsPerKeyword ?? 5), maxEstimatedNoteDetails: Number(body.maxEstimatedNoteDetails ?? 1500), excludedTerms: Array.isArray(body.excludedTerms) ? body.excludedTerms : [] }, createdAt: new Date().toISOString() });
    sendJson(response, 200, plan); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/keywords/run") {
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    sendJson(response, 200, { runs: runtime.keywordRuns ?? [], active: (runtime.keywordRuns ?? []).find((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status)) ?? null }); return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/collection/target") {
    const body = await parseBody(request);
    const searchLimit = Number(body.searchLimit);
    if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 10000) throw new Error("INVALID_COLLECTION_SEARCH_LIMIT");
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    reconcileRankingRuns(runtime);
    const progress = currentCollectionProgress(runtime);
    const run = progress.active ? progress.run : null;
    if (run) {
      if (searchLimit < progress.admitted) throw new Error("TARGET_BELOW_ALREADY_ADMITTED");
      run.settings.searchLimit = searchLimit;
      runtime.browserTasks = (runtime.browserTasks ?? []).map((task) => task.context?.runId === run.runId && ["QUEUED", "LEASED"].includes(task.status)
        ? { ...task, context: { ...task.context, searchLimit } }
        : task);
      const now = new Date().toISOString();
      Object.assign(run, progress.runKind === "KEYWORD" ? reconcileKeywordBrowserRun(run, runtime.browserTasks, now) : reconcileRankingBrowserRun(run, runtime.browserTasks, now));
      runtime.updatedAt = now;
      await writeJson(runtimeStatePath, runtime);
    }
    sendJson(response, 200, { run, runKind: progress.active ? progress.runKind : null, nextRunSearchLimit: searchLimit }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/keywords/run") {
    const body = await parseBody(request);
    if (!body.plan || !Array.isArray(body.plan.nodes)) throw new Error("KEYWORD_PLAN_REQUIRED");
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    if ((runtime.keywordRuns ?? []).some((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status))) throw new Error("KEYWORD_RUN_ALREADY_ACTIVE");
    const now = new Date().toISOString();
    const { run, tasks } = createKeywordBrowserRun(body.plan, body.settings ?? {}, now);
    if (body.previewOnly === true) { sendJson(response, 200, { run, dispatchedTasks: tasks.length, tasks, previewOnly: true }); return true; }
    const queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    for (const task of tasks) queue.enqueue(task, now);
    runtime.browserTasks = queue.list();
    runtime.keywordRuns = [run, ...(runtime.keywordRuns ?? [])].slice(0, 20);
    runtime.updatedAt = now;
    await writeJson(runtimeStatePath, runtime);
    sendJson(response, 202, { run, dispatchedTasks: tasks.length }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/keywords/run/control") {
    const body = await parseBody(request);
    const runtime = await runtimeState();
    reconcileKeywordRuns(runtime);
    const run = (runtime.keywordRuns ?? []).find((item) => item.runId === body.runId) ?? (runtime.keywordRuns ?? []).find((item) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(item.status));
    if (!run) throw new Error("NO_ACTIVE_KEYWORD_RUN");
    const action = String(body.action ?? ""); const now = new Date().toISOString();
    let queue = new BrowserTaskQueue(runtime.browserTasks ?? []);
    if (action === "PAUSE" && ["QUEUED", "RUNNING"].includes(run.status)) run.status = "PAUSED";
    else if (action === "RESUME" && run.status === "PAUSED") run.status = "RUNNING";
    else if (action === "CANCEL" && ["QUEUED", "RUNNING", "PAUSED"].includes(run.status)) { run.status = "CANCEL_REQUESTED"; queue.cancelByRun(run.runId, now); }
    else if (action === "ENRICH" && ["QUEUED", "RUNNING", "PAUSED"].includes(run.status)) {
      run.settings = { ...(run.settings ?? {}), autoCollectNotes: true };
      runtime.browserTasks = (runtime.browserTasks ?? []).map((task) => task.context?.runId === run.runId && task.expectedPageType === "SEARCH"
        ? { ...task, context: { ...(task.context ?? {}), autoCollectNotes: true, collectNotes: true } }
        : task);
      queue = new BrowserTaskQueue(runtime.browserTasks);
    }
    else throw new Error("INVALID_KEYWORD_RUN_CONTROL");
    runtime.browserTasks = queue.list();
    Object.assign(run, reconcileKeywordBrowserRun(run, runtime.browserTasks, now));
    runtime.updatedAt = now; await writeJson(runtimeStatePath, runtime);
    sendJson(response, 200, { run }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collection/run") {
    const body = await parseBody(request);
    if (body.mode !== "OFFLINE_FIXTURE") throw new Error("REAL_SOURCE_NOT_CONFIGURED");
    if (collectionActive) throw new Error("COLLECTION_ALREADY_RUNNING");
    const now = new Date().toISOString();
    const jobId = `collection-${Date.now()}`;
    collectionJob = { jobId, mode: body.mode, status: "QUEUED", phase: "QUEUED", pauseRequested: false, cancelRequested: false, createdAt: now, updatedAt: now };
    collectionActive = true;
    setImmediate(() => executeCollectionJob(jobId));
    sendJson(response, 202, { ...collectionJob }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/collection/job") {
    sendJson(response, 200, collectionJob ? { ...collectionJob, abortController: undefined } : { status: "IDLE" }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/collection/control") {
    const body = await parseBody(request);
    if (!collectionJob || !["QUEUED", "RUNNING", "PAUSED"].includes(collectionJob.status)) throw new Error("NO_ACTIVE_COLLECTION_JOB");
    if (body.action === "PAUSE") collectionJob.pauseRequested = true;
    else if (body.action === "RESUME") collectionJob.pauseRequested = false;
    else if (body.action === "CANCEL") { collectionJob.cancelRequested = true; collectionJob.pauseRequested = false; collectionJob.abortController?.abort(); }
    else throw new Error("INVALID_COLLECTION_CONTROL");
    collectionJob.updatedAt = new Date().toISOString();
    sendJson(response, 200, { ...collectionJob, abortController: undefined }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/ranking-run.json") {
    const runtime = await runtimeState();
    reconcileRankingRuns(runtime);
    const requestedRunId = url.searchParams.get("runId")?.trim();
    const runs = [...(runtime.rankingRuns ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const run = requestedRunId ? runs.find((item) => item.runId === requestedRunId) : runs[0];
    if (!run) { sendJson(response, 404, { error: requestedRunId ? "RANKING_RUN_NOT_FOUND" : "RANKING_RUN_EMPTY" }); return true; }
    const bundle = createRankingRunAuditBundle(run, runtime.browserTasks ?? [], new Date().toISOString());
    const content = `${JSON.stringify(bundle, null, 2)}\n`;
    const safeRunId = run.runId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    response.writeHead(200, {
      "content-type": mime[".json"],
      "content-disposition": `attachment; filename=${safeRunId}.audit.json`,
      "cache-control": "no-store",
      "x-audit-payload-sha256": bundle.receipt.sha256,
    });
    response.end(content); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/database.json") {
    response.writeHead(200, { "content-type": mime[".json"], "content-disposition": "attachment; filename=workbench-database.json" });
    createReadStream(databasePath).pipe(response); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/browser-database.json") {
    try {
      await stat(browserEvidenceDatabasePath);
      const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
      const exported = await store.exportDocument();
      store.close();
      response.writeHead(200, { "content-type": mime[".json"], "content-disposition": "attachment; filename=browser-evidence-database.json" });
      response.end(`${JSON.stringify(exported, null, 2)}\n`);
    } catch { sendJson(response, 404, { error: "BROWSER_EVIDENCE_DATABASE_EMPTY" }); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/browser-notes.csv") {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try {
      const notes = await store.searchNotes("", { limit: 500 });
      const rows = [["note_id", "title", "body", "author", "keywords", "likes", "collects", "comments", "detail_status", "observed_at"], ...notes.map((note) => [note.noteId, note.title, note.body, note.author?.displayName, (note.keywords ?? []).join("|"), note.metrics?.likes, note.metrics?.collects, note.metrics?.comments, note.detailStatus, note.metrics?.observedAt])];
      sendDownload(response, mime[".csv"], "browser-evidence-notes.csv", `\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}\r\n`);
    } finally { store.close(); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/browser-research.md") {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try {
      const notes = await store.searchNotes("", { limit: 500 });
      const integrity = store.integrity();
      const lines = ["# 小红书采集研究包", "", `导出时间：${new Date().toISOString()}`, `数据范围：SQLite 真实浏览器证据库，共 ${notes.length} 条笔记`, `数据库：schema ${integrity.schemaVersion} / integrity ${integrity.sqliteResult}`, "", "| 标题 | 作者 | 点赞 | 收藏 | 评论 | 详情状态 | 关键词 |", "|---|---|---:|---:|---:|---|---|", ...notes.map((note) => `| ${escapeMarkdown(note.title)} | ${escapeMarkdown(note.author?.displayName)} | ${note.metrics?.likes ?? "缺失"} | ${note.metrics?.collects ?? "缺失"} | ${note.metrics?.comments ?? "缺失"} | ${escapeMarkdown(note.detailStatus)} | ${escapeMarkdown((note.keywords ?? []).join("、"))} |`), "", "## 证据边界", "", "本研究包只包含已写入本地 SQLite 的可审计证据；空库或字段缺失不会被补写为平台事实。", ""];
      sendDownload(response, "text/markdown; charset=utf-8", "browser-evidence-research.md", lines.join("\n"));
    } finally { store.close(); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/database/backup") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(databaseBackupRoot, `evidence-${stamp}.sqlite`);
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try {
      const integrity = await store.backup(backupPath);
      if (integrity.status !== "OK") throw new Error("BACKUP_INTEGRITY_FAILED");
    } finally { store.close(); }
    const info = await stat(backupPath);
    response.writeHead(200, { "content-type": "application/vnd.sqlite3", "content-disposition": `attachment; filename=${path.basename(backupPath)}`, "content-length": String(info.size), "cache-control": "no-store" });
    createReadStream(backupPath).pipe(response); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/database/restore") {
    if (url.searchParams.get("confirm") !== "true") throw new Error("RESTORE_EXPLICIT_CONFIRMATION_REQUIRED");
    const uploaded = await parseBinaryBody(request);
    const uploadPath = path.join(databaseReceiptRoot, `restore-upload-${Date.now()}-${createHash("sha256").update(uploaded).digest("hex").slice(0, 12)}.sqlite`);
    await mkdir(databaseReceiptRoot, { recursive: true }); await writeFile(uploadPath, uploaded);
    try {
      const receipt = await restoreSqliteDatabase({ activePath: browserEvidenceDatabasePath, candidatePath: uploadPath, backupDirectory: databaseBackupRoot });
      const receiptPath = path.join(databaseReceiptRoot, `${receipt.receiptId}.json`);
      await writeJson(receiptPath, receipt);
      sendJson(response, 200, { ...receipt, sourcePath: "uploaded-file", destinationPath: path.basename(browserEvidenceDatabasePath), backupPath: receipt.backupPath ? path.relative(projectRoot, receipt.backupPath) : null, receiptPath: path.relative(projectRoot, receiptPath) });
    } finally { await rm(uploadPath, { force: true }); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/database/status") {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try { sendJson(response, 200, { ...store.integrity(), startupMigration }); } finally { store.close(); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/database/notes") {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try {
      const detailStatus = url.searchParams.get("detailStatus");
      const notes = await store.searchNotes(url.searchParams.get("q") ?? "", {
        author: url.searchParams.get("author") ?? undefined,
        keyword: url.searchParams.get("keyword") ?? undefined,
        detailStatus: detailStatus === "COMPLETE" || detailStatus === "INCOMPLETE" ? detailStatus : undefined,
        tag: url.searchParams.get("tag") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 100),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
      sendJson(response, 200, { count: notes.length, notes });
    } finally { store.close(); }
    return true;
  }
  if (request.method === "PUT" && /^\/api\/database\/notes\/[^/]+\/tags$/.test(url.pathname)) {
    const noteId = decodeURIComponent(url.pathname.split("/")[4]);
    const body = await parseBody(request);
    if (!Array.isArray(body.tags)) throw new Error("TAGS_ARRAY_REQUIRED");
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try { sendJson(response, 200, { noteId, tags: await store.setNoteTags(noteId, body.tags.map(String)) }); } finally { store.close(); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/database/views") {
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try { sendJson(response, 200, { views: await store.listViews() }); } finally { store.close(); }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/database/views") {
    const body = await parseBody(request);
    const now = new Date().toISOString();
    if (!String(body.viewId ?? "").trim() || !String(body.name ?? "").trim()) throw new Error("VIEW_ID_AND_NAME_REQUIRED");
    const store = new SqliteEvidenceStore(browserEvidenceDatabasePath);
    try {
      await store.saveView({ viewId: String(body.viewId), name: String(body.name), query: String(body.query ?? ""), filters: body.filters && typeof body.filters === "object" ? body.filters : {}, createdAt: String(body.createdAt ?? now), updatedAt: now });
      sendJson(response, 200, { status: "SAVED", viewId: String(body.viewId) });
    } finally { store.close(); }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/export/notes.csv") {
    const database = await readJson(databasePath);
    const rows = [["note_id", "title", "author", "likes", "collects", "comments"], ...(database.notes ?? []).map((note) => [note.noteId, note.title, note.author?.displayName, note.metrics?.likes, note.metrics?.collects, note.metrics?.comments])];
    const csv = `\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}`;
    response.writeHead(200, { "content-type": mime[".csv"], "content-disposition": "attachment; filename=workbench-notes.csv" });
    response.end(csv); return true;
  }
  return false;
}

startupMigration = await migrateLegacyJsonDatabase({ legacyPath: legacyBrowserEvidenceDatabasePath, sqlitePath: browserEvidenceDatabasePath, receiptPath: path.join(databaseReceiptRoot, "legacy-json-migration.json") });
await initializeModelSettings();
await recoverRuntimeAtStartup();
await rebuildMonitor();

createServer(async (request, response) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) {
      response.writeHead(403).end("Forbidden host");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const origin = request.headers.origin;
    if (url.pathname.startsWith("/api/") && origin) {
      if (!allowedApiOrigin(origin)) {
        response.writeHead(403).end("Forbidden origin");
        return;
      }
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      response.writeHead(204, { "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "content-type" }).end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!await apiRoute(request, response, url)) sendJson(response, 404, { error: "API_NOT_FOUND" });
      return;
    }
    const requested = decodeURIComponent(url.pathname);
    const relative = requested === "/" ? "apps/workbench-ui/index.html" : requested.replace(/^\/+/, "");
    const target = path.resolve(projectRoot, relative);
    const publicRoot = path.join(projectRoot, "apps/workbench-ui");
    if (!target.startsWith(`${publicRoot}${path.sep}`)) return response.writeHead(403).end("Forbidden");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": mime[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(target).pipe(response);
  } catch (error) {
    if ((request.url ?? "").startsWith("/api/")) return sendJson(response, 400, { error: error instanceof Error ? error.message : "REQUEST_FAILED" });
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`XHS workbench UI: http://127.0.0.1:${port}`));
