(function registerLeaseRecoveryController(root) {
  function decide(localTask, remoteTask, now = Date.now()) {
    if (!localTask) return { action: "CLAIM", reason: "NO_LOCAL_TASK" };
    if (!remoteTask) return { action: "CLEAR_AND_CLAIM", reason: "REMOTE_TASK_MISSING" };
    if (remoteTask.taskId !== localTask.taskId) return { action: "CLEAR_AND_CLAIM", reason: "TASK_ID_MISMATCH" };
    if (remoteTask.status !== "LEASED") return { action: "CLEAR_AND_CLAIM", reason: `REMOTE_TASK_${remoteTask.status || "UNKNOWN"}` };
    if (!remoteTask.lease?.token || remoteTask.lease.token !== localTask.lease?.token) {
      return { action: "CLEAR_AND_CLAIM", reason: "LEASE_TOKEN_MISMATCH" };
    }
    const expiresAt = Date.parse(remoteTask.lease.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { action: "CLEAR_AND_CLAIM", reason: "LEASE_EXPIRED" };
    return { action: "KEEP", reason: "LEASE_CONFIRMED", task: remoteTask };
  }

  root.XhsLeaseRecoveryController = { decide };
})(globalThis);
