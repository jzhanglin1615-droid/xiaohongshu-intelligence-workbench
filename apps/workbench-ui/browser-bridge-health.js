const acceptedPageTypes = new Set(["SEARCH", "NOTE_DETAIL", "HUMAN_VERIFICATION", "UNKNOWN"]);
const acceptedCapabilities = new Set(["visibleReadOnly", "taskLease", "autoRun", "commentTraversal", "leaseRecovery"]);

export function sanitizeHeartbeatPageUrl(value) {
  if (!value) return null;
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com") throw new Error("INVALID_HEARTBEAT_PAGE_URL");
  const safe = new URL(`${url.origin}${url.pathname}`);
  if (url.pathname === "/search_result") {
    const keyword = String(url.searchParams.get("keyword") ?? "").trim();
    if (keyword) safe.searchParams.set("keyword", keyword.slice(0, 120));
  }
  return safe.href;
}

export function normalizeBrowserHeartbeat(body, receivedAt = new Date().toISOString()) {
  const clientId = String(body?.clientId ?? "").trim();
  if (!/^extension-[a-zA-Z0-9-]{8,128}$/.test(clientId)) throw new Error("INVALID_BROWSER_CLIENT_ID");
  const extensionVersion = String(body?.extensionVersion ?? "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(extensionVersion)) throw new Error("INVALID_EXTENSION_VERSION");
  const contentScriptVersion = String(body?.contentScriptVersion ?? "").trim();
  if (contentScriptVersion && !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(contentScriptVersion)) throw new Error("INVALID_CONTENT_SCRIPT_VERSION");
  const capabilities = [...new Set(Array.isArray(body?.capabilities) ? body.capabilities.filter((item) => acceptedCapabilities.has(item)) : [])].sort();
  return {
    clientId,
    extensionVersion,
    contentScriptVersion: contentScriptVersion || null,
    versionStatus: contentScriptVersion === extensionVersion ? "MATCHED" : "RELOAD_REQUIRED",
    pageType: acceptedPageTypes.has(body?.pageType) ? body.pageType : "UNKNOWN",
    pageUrl: sanitizeHeartbeatPageUrl(body?.pageUrl),
    capabilities,
    autoRunStatus: ["RUNNING", "RETRYING", "STOPPED", "HALTED"].includes(body?.autoRunStatus) ? body.autoRunStatus : "UNKNOWN",
    receivedAt,
  };
}

export function summarizeBrowserBridge(runtime, now = new Date().toISOString(), freshForMs = 45_000) {
  const nowMs = Date.parse(now);
  const clients = (runtime?.browserBridge?.clients ?? [])
    .filter((client) => Number.isFinite(Date.parse(client.receivedAt)))
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
  const latestClient = clients[0] ?? null;
  const activeClients = clients.filter((client) => nowMs - Date.parse(client.receivedAt) <= freshForMs);
  return {
    connectionStatus: activeClients.length > 0 ? "CONNECTED" : latestClient ? "STALE" : "NOT_CONNECTED",
    activeClientCount: activeClients.length,
    latestClient,
    lastSnapshot: runtime?.browserBridge?.lastSnapshot ?? null,
    lastFieldValidation: runtime?.browserBridge?.lastFieldValidation ?? null,
    lastHumanComparison: runtime?.browserBridge?.lastHumanComparison ?? null,
    acceptedPageTypes: ["SEARCH", "NOTE_DETAIL"],
    mode: "VISIBLE_PAGE_READ_ONLY",
    heartbeatFreshForMs: freshForMs,
  };
}
