const DEFAULT_INTERVAL_MINUTES = 60;

function rankingScopeFromUrl(url) {
  const keyword = String(url.searchParams.get("keyword") ?? "").trim();
  const safeKeyword = keyword.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `ranking:auto:${safeKeyword || "current-search"}`;
}

export function deriveAutomaticRankingMonitor(currentConfig = {}, heartbeat = {}) {
  if (currentConfig.autoArmSuppressed === true) return { changed: false, config: currentConfig, reason: "AUTO_ARM_SUPPRESSED" };
  if (heartbeat.pageType !== "SEARCH" || !heartbeat.pageUrl) return { changed: false, config: currentConfig, reason: "NOT_SEARCH_PAGE" };
  let target;
  try { target = new URL(heartbeat.pageUrl); } catch { return { changed: false, config: currentConfig, reason: "INVALID_SEARCH_URL" }; }
  if (target.protocol !== "https:" || target.hostname !== "www.xiaohongshu.com" || target.pathname !== "/search_result") {
    return { changed: false, config: currentConfig, reason: "UNSUPPORTED_SEARCH_URL" };
  }
  const canonicalTarget = target.href;
  if (currentConfig.mode === "REAL_ADAPTER" && currentConfig.targetUrl === canonicalTarget && currentConfig.collectorKind === "EXTENSION") {
    return { changed: false, config: currentConfig, reason: "ALREADY_ARMED" };
  }
  return {
    changed: true,
    reason: "REAL_SEARCH_PAGE_CONNECTED",
    config: {
      ...currentConfig,
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      scopeId: rankingScopeFromUrl(target),
      mode: "REAL_ADAPTER",
      collectorKind: "EXTENSION",
      targetUrl: canonicalTarget,
      maxDetailTargets: Number.isInteger(currentConfig.maxDetailTargets) ? currentConfig.maxDetailTargets : 0,
      maxRefillRounds: Number.isInteger(currentConfig.maxRefillRounds) ? currentConfig.maxRefillRounds : 2,
      requestIntervalMs: Number.isInteger(currentConfig.requestIntervalMs) ? currentConfig.requestIntervalMs : 8000,
      slowNetworkMaxWaitMs: Number.isInteger(currentConfig.slowNetworkMaxWaitMs) ? currentConfig.slowNetworkMaxWaitMs : 300000,
    },
  };
}
