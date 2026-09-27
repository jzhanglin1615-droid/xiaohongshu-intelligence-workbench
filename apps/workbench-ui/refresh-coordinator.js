// Read coordination only. Never starts, stops, or retries a collection task.
export function createRefreshCoordinator({ now = Date.now } = {}) {
  const flights = new Map();
  let failures = 0;
  let nextPollAt = 0;
  const single = (key, work) => {
    if (flights.has(key)) return flights.get(key);
    const pending = Promise.resolve().then(work);
    flights.set(key, pending);
    const cleanup = () => { if (flights.get(key) === pending) flights.delete(key); };
    pending.then(cleanup, cleanup);
    return pending;
  };
  return {
    single,
    poll(work, { active = false, hidden = false } = {}) {
      if (hidden || now() < nextPollAt) return Promise.resolve(false);
      return single("poll", async () => {
        try {
          await work();
          failures = 0;
          nextPollAt = now() + (active ? 2000 : 10000);
          return true;
        } catch (error) {
          failures++;
          nextPollAt = now() + Math.min(30000, 2000 * 2 ** Math.min(failures, 4));
          throw error;
        }
      });
    },
  };
}

// A changed snapshot or a timeout is not proof that a collection finished.
export function pendingRefreshFeedback(pending, signature, now = Date.now(), runtime = {}) {
  const changed = signature !== pending.baseline;
  const statuses = (pending.targets ?? []).map(target => {
    if (target.status) return target.status;
    if (target.runId) return (runtime.keywordRuns ?? []).find(run => run.runId === target.runId)?.status;
    const dispatch = (runtime.rankingDispatchHistory ?? []).find(item => item.browserTaskId === target.taskId);
    const task = (runtime.browserTasks ?? []).find(item => item.taskId === target.taskId);
    const runId = dispatch?.rankingRunId ?? task?.context?.runId;
    // A search task alone succeeding does not prove the whole ranking run finished.
    return (runtime.rankingRuns ?? []).find(run => run.runId === runId)?.status;
  });
  const terminal = ["SUCCEEDED", "FAILED", "CANCELLED", "PARTIAL"];
  if (statuses.length && statuses.every(status => terminal.includes(status))) {
    if (statuses.some(status => status !== "SUCCEEDED")) return {
      done: true, tone: "error", message: "本轮已结束，但有任务失败、取消或未完成全部目标；已采数据保留，请查看任务明细",
    };
    pending = { ...pending, completed: true };
  }
  if (statuses.some(status => ["PAUSED", "BLOCKED"].includes(status))) return {
    done: false, tone: "error", message: "部分任务已暂停或受阻；已采数据保留，请查看任务明细后继续",
  };
  if (pending.completed === true) return {
    done: true, tone: changed ? "success" : "muted",
    message: changed ? "检查已完成，榜单或观测时间有变化" : "检查已完成，暂无数据变化",
  };
  return {
    done: false, tone: "loading",
    message: changed ? "已收到新数据，任务完成状态仍待确认" : now - pending.startedAt >= 90000
      ? "仍未收到完成确认；可同步查看状态，请勿重复启动任务" : "任务已发起，等待新数据和完成确认",
  };
}
