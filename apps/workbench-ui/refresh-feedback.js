export function describeRefreshOutcome({ receipt, beforeSignature, afterSignature, afterCount = 0 }) {
  if (receipt?.status === "SKIPPED_OVERLAP") return { tone: "info", message: "已有一次更新正在进行，完成后会自动显示" };
  if (receipt?.status === "DISPATCHED" || receipt?.status === "SUCCEEDED" && receipt?.capture?.kind === "BROWSER_TASK") {
    return { tone: "info", message: "更新任务已发出；新数据到达后会自动显示" };
  }
  if (receipt?.status !== "SUCCEEDED") return { tone: "error", message: receipt?.status === "FAILED" ? "更新失败，保留已有数据" : "尚未收到有效的更新完成回执" };
  if (beforeSignature !== afterSignature) {
    return { tone: "success", message: `更新完成：当前 ${Number(afterCount) || 0} 条候选，榜单或观测时间有更新（互动数未必变化）` };
  }
  return { tone: "info", message: `更新完成：当前 ${Number(afterCount) || 0} 条候选，暂无数据变化` };
}
