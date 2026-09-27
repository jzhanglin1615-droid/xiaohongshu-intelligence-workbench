importScripts("lease-recovery-controller.js");

const WORKBENCH = "http://127.0.0.1:4173";
const BACKGROUND_COLLECTION_ALARM = "xhs-background-collection";

function normalizeSearchLimit(value, fallback = 1500) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : fallback;
}

async function collectionSettings() {
  const stored = (await chrome.storage.local.get("browserCollectionSettings")).browserCollectionSettings || {};
  return { searchLimit: normalizeSearchLimit(stored.searchLimit), updatedAt: stored.updatedAt || null };
}

async function setCollectionSettings(searchLimit) {
  const value = { searchLimit: normalizeSearchLimit(searchLimit), updatedAt: new Date().toISOString() };
  const target = await request("/api/collection/target", { method: "PUT", body: JSON.stringify({ searchLimit: value.searchLimit }) });
  const activeCollectionRun = target.run || null;
  await chrome.storage.local.set({ browserCollectionSettings: value });
  // Keep newly dispatched ranking tasks aligned with the target shown in the overlay.
  try {
    const status = await request("/api/status");
    const current = status.rankingMonitor || {};
    await request("/api/ranking/config", {
      method: "PUT",
      body: JSON.stringify({
        ...current,
        enabled: false,
        intervalMinutes: 60,
        mode: current.mode || "REAL_ADAPTER",
        targetUrl: current.targetUrl || "https://www.xiaohongshu.com/search_result",
        searchLimit: value.searchLimit,
        maxDetailTargets: 0,
        maxRefillRounds: 0,
      }),
    });
    return { ...value, workbenchSynced: true, activeCollectionRun };
  } catch (error) {
    return { ...value, workbenchSynced: Boolean(activeCollectionRun), activeCollectionRun, syncWarning: error instanceof Error ? error.message : "WORKBENCH_SETTINGS_SYNC_FAILED" };
  }
}

async function setBackgroundAlarm(enabled) {
  if (enabled) {
    await chrome.alarms.create(BACKGROUND_COLLECTION_ALARM, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(BACKGROUND_COLLECTION_ALARM);
  }
}

async function wakeXiaohongshuTabs() {
  const state = await autoRunState();
  if (!state.enabled) return;
  const tabs = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
  await Promise.allSettled(tabs.map((tab) => tab.id ? chrome.tabs.sendMessage(tab.id, { kind: "BACKGROUND_COLLECTION_TICK" }) : Promise.resolve()));
}

async function clientId() {
  const stored = await chrome.storage.local.get("browserClientId");
  if (stored.browserClientId) return stored.browserClientId;
  const value = `extension-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ browserClientId: value });
  return value;
}

async function activeTask() {
  return (await chrome.storage.local.get("activeBrowserTask")).activeBrowserTask || null;
}

async function reconciledActiveTask() {
  const localTask = await activeTask();
  if (!localTask) return null;
  const remote = await request("/api/browser-bridge/tasks");
  const remoteTask = (remote.tasks || []).find((task) => task.taskId === localTask.taskId) || null;
  const decision = globalThis.XhsLeaseRecoveryController.decide(localTask, remoteTask, Date.now());
  if (decision.action === "KEEP") {
    await chrome.storage.local.set({ activeBrowserTask: decision.task });
    return decision.task;
  }
  await chrome.storage.local.remove("activeBrowserTask");
  return null;
}

async function autoRunState() {
  return (await chrome.storage.local.get("browserAutoRun")).browserAutoRun || { enabled: false, status: "STOPPED", userPaused: false, updatedAt: null, lastError: null };
}

async function setAutoRun(enabled, lastError = null, userInitiated = false) {
  const previous = await autoRunState();
  const userPaused = enabled ? false : (userInitiated && !lastError ? true : previous.userPaused === true);
  const value = { enabled, status: enabled ? (lastError ? "RETRYING" : "RUNNING") : (lastError ? "HALTED" : "STOPPED"), userPaused, updatedAt: new Date().toISOString(), lastError };
  await chrome.storage.local.set({ browserAutoRun: value });
  await setBackgroundAlarm(enabled);
  return value;
}

async function request(path, options = {}) {
  const response = await fetch(`${WORKBENCH}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const extensionVersion = chrome.runtime.getManifest().version;
  const contentScriptVersion = String(message?.contentScriptVersion || "");
  const staleContentScript = contentScriptVersion !== extensionVersion;
  if (staleContentScript && !["EXTENSION_HEARTBEAT", "WORKBENCH_STATUS"].includes(message?.kind)) {
    respond({ ok: false, error: "STALE_CONTENT_SCRIPT_REFRESH_REQUIRED" });
    return false;
  }
  if (message?.kind === "EXTENSION_HEARTBEAT") {
    Promise.all([clientId(), autoRunState()]).then(([id, autoRun]) => request("/api/browser-bridge/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        clientId: id,
        extensionVersion,
        contentScriptVersion: contentScriptVersion || null,
        pageUrl: message.pageUrl,
        pageType: message.pageType,
        autoRunStatus: autoRun.status,
        capabilities: ["visibleReadOnly", "taskLease", "autoRun", "commentTraversal", "leaseRecovery"],
      }),
    })).then((value) => respond({ ok: true, value: { ...value, reloadRequired: staleContentScript } })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "WORKBENCH_STATUS") {
    request("/api/browser-bridge/status").then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SUBMIT_VISIBLE_SNAPSHOT") {
    activeTask().then((task) => request("/api/browser-bridge/snapshot", { method: "POST", body: JSON.stringify({ ...message.snapshot, bridgeTask: task ? { taskId: task.taskId, leaseToken: task.lease.token } : undefined }) }))
      .then(async (value) => { if (value.task) await chrome.storage.local.remove("activeBrowserTask"); respond({ ok: true, value }); })
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SUBMIT_DIAGNOSTIC_SNAPSHOT") {
    request("/api/browser-bridge/snapshot", { method: "POST", body: JSON.stringify(message.snapshot) })
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SUBMIT_SEARCH_PROGRESS") {
    request("/api/browser-bridge/snapshot", { method: "POST", body: JSON.stringify(message.snapshot) })
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_ACTIVE_BROWSER_TASK") {
    reconciledActiveTask().then((task) => respond({ ok: true, value: task })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "LEASE_BROWSER_TASK") {
    Promise.all([clientId(), reconciledActiveTask()]).then(async ([id, current]) => {
      if (current) return current;
      const result = await request("/api/browser-bridge/tasks/lease", { method: "POST", body: JSON.stringify({ clientId: id }) });
      if (result.task) await chrome.storage.local.set({ activeBrowserTask: result.task });
      return result.task;
    }).then((task) => respond({ ok: true, value: task })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "FAIL_BROWSER_TASK") {
    activeTask().then(async (task) => {
      if (!task?.lease?.token) throw new Error("NO_ACTIVE_BROWSER_TASK");
      const result = await request("/api/browser-bridge/tasks/fail", { method: "POST", body: JSON.stringify({ taskId: task.taskId, leaseToken: task.lease.token, category: message.category, code: message.code, message: message.message }) });
      await chrome.storage.local.remove("activeBrowserTask");
      return result;
    }).then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SKIP_BROWSER_TASK") {
    activeTask().then(async (task) => {
      if (!task?.lease?.token) throw new Error("NO_ACTIVE_BROWSER_TASK");
      const result = await request("/api/browser-bridge/tasks/skip", { method: "POST", body: JSON.stringify({ taskId: task.taskId, leaseToken: task.lease.token, code: message.code, message: message.message }) });
      await chrome.storage.local.remove("activeBrowserTask");
      return result;
    }).then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_BROWSER_AUTORUN") {
    autoRunState().then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_COLLECTION_SETTINGS") {
    collectionSettings().then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SET_COLLECTION_SETTINGS") {
    const searchLimit = Number(message.searchLimit);
    if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 10000) {
      respond({ ok: false, error: "INVALID_COLLECTION_SEARCH_LIMIT" });
      return false;
    }
    setCollectionSettings(searchLimit).then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "SET_BROWSER_AUTORUN") {
    setAutoRun(message.enabled === true, message.lastError ? String(message.lastError) : null, message.userInitiated === true)
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_RANKING_RUN") {
    request("/api/ranking/run")
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_KEYWORD_RUN") {
    request("/api/keywords/run")
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "GET_COLLECTION_PROGRESS") {
    request("/api/collection/progress")
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "COLLECTION_RUN_CONTROL") {
    const path = message.runKind === "KEYWORD" ? "/api/keywords/run/control" : message.runKind === "RANKING" ? "/api/ranking/run/control" : null;
    if (!path || !message.runId) { respond({ ok: false, error: "NO_ACTIVE_COLLECTION_RUN" }); return false; }
    request(path, { method: "POST", body: JSON.stringify({ action: message.action, runId: message.runId }) })
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "RANKING_RUN_CONTROL") {
    request("/api/ranking/run/control", { method: "POST", body: JSON.stringify({ action: message.action, runId: message.runId }) })
      .then((value) => respond({ ok: true, value }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKGROUND_COLLECTION_ALARM) void wakeXiaohongshuTabs();
});

chrome.runtime.onInstalled.addListener(() => {
  void autoRunState().then((state) => setBackgroundAlarm(state.enabled));
});

chrome.runtime.onStartup.addListener(() => {
  void autoRunState().then((state) => setBackgroundAlarm(state.enabled));
});
