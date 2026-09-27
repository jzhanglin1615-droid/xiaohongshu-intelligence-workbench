import { randomUUID } from "node:crypto";
import type { BrowserCaptureTask } from "./browser-task-queue.ts";
import { BrowserTaskQueue } from "./browser-task-queue.ts";
import type { KeywordBrowserRun } from "./keyword-browser-run.ts";
import { reconcileKeywordBrowserRun } from "./keyword-browser-run.ts";
import type { RankingBrowserRun } from "./ranking-browser-run.ts";
import { reconcileRankingBrowserRun } from "./ranking-browser-run.ts";

export interface WorkbenchStartupRecoveryReceipt {
  recoveryId: string;
  recoveredAt: string;
  status: "NO_CHANGES" | "RECOVERED";
  recoveredTaskIds: string[];
  preservedActiveLeaseTaskIds: string[];
  runTransitions: Array<{ runKind: "KEYWORD" | "RANKING"; runId: string; from: string; to: string }>;
}

export interface RecoverableWorkbenchRuntime {
  browserTasks?: BrowserCaptureTask[];
  keywordRuns?: KeywordBrowserRun[];
  rankingRuns?: RankingBrowserRun[];
  startupRecoveryHistory?: WorkbenchStartupRecoveryReceipt[];
  updatedAt?: string;
  [key: string]: unknown;
}

export function recoverWorkbenchRuntime<T extends RecoverableWorkbenchRuntime>(runtime: T, now: string, recoveryId = `startup-recovery-${randomUUID()}`): { runtime: T; receipt: WorkbenchStartupRecoveryReceipt } {
  const next = structuredClone(runtime);
  const queue = new BrowserTaskQueue(next.browserTasks ?? []);
  const recovered = queue.recoverExpired(now);
  next.browserTasks = queue.list();
  const taskList = next.browserTasks;
  const runTransitions: WorkbenchStartupRecoveryReceipt["runTransitions"] = [];
  next.keywordRuns = (next.keywordRuns ?? []).map((run) => {
    const reconciled = reconcileKeywordBrowserRun(run, taskList, now);
    if (reconciled.status !== run.status) runTransitions.push({ runKind: "KEYWORD", runId: run.runId, from: run.status, to: reconciled.status });
    return reconciled;
  });
  next.rankingRuns = (next.rankingRuns ?? []).map((run) => {
    const reconciled = reconcileRankingBrowserRun(run, taskList, now);
    if (reconciled.status !== run.status) runTransitions.push({ runKind: "RANKING", runId: run.runId, from: run.status, to: reconciled.status });
    return reconciled;
  });
  const receipt: WorkbenchStartupRecoveryReceipt = {
    recoveryId,
    recoveredAt: now,
    status: recovered.length || runTransitions.length ? "RECOVERED" : "NO_CHANGES",
    recoveredTaskIds: recovered.map((task) => task.taskId).sort(),
    preservedActiveLeaseTaskIds: taskList.filter((task) => task.status === "LEASED" && task.lease && Date.parse(task.lease.expiresAt) > Date.parse(now)).map((task) => task.taskId).sort(),
    runTransitions,
  };
  next.startupRecoveryHistory = [receipt, ...(next.startupRecoveryHistory ?? []).filter((item) => item.recoveryId !== recoveryId)].slice(0, 50);
  next.updatedAt = now;
  return { runtime: next, receipt };
}
