import assert from "node:assert/strict";
import test from "node:test";
import { deriveAutomaticRankingMonitor } from "./auto-ranking-monitor.js";

test("a real visible search page configures but does not automatically enable ranking monitoring", () => {
  const current = { enabled: false, mode: "OFFLINE_FIXTURE", intervalMinutes: 1, maxDetailTargets: 12, maxRefillRounds: 2, requestIntervalMs: 8000, slowNetworkMaxWaitMs: 300000 };
  const result = deriveAutomaticRankingMonitor(current, { pageType: "SEARCH", pageUrl: "https://www.xiaohongshu.com/search_result?keyword=%E7%BE%8E%E9%A3%9F" });
  assert.equal(result.changed, true);
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.mode, "REAL_ADAPTER");
  assert.equal(result.config.intervalMinutes, 60);
  assert.equal(result.config.collectorKind, "EXTENSION");
  assert.equal(result.config.scopeId, "ranking:auto:美食");
  assert.equal(result.config.maxDetailTargets, 12);
});

test("detail and unknown pages never reconfigure ranking monitoring", () => {
  const current = { enabled: false, mode: "OFFLINE_FIXTURE" };
  assert.equal(deriveAutomaticRankingMonitor(current, { pageType: "NOTE_DETAIL", pageUrl: "https://www.xiaohongshu.com/explore/1" }).changed, false);
  assert.equal(deriveAutomaticRankingMonitor(current, { pageType: "SEARCH", pageUrl: "https://example.com/search_result?keyword=x" }).changed, false);
});

test("an already armed monitor is idempotent", () => {
  const current = { enabled: false, mode: "REAL_ADAPTER", collectorKind: "EXTENSION", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=x" };
  const result = deriveAutomaticRankingMonitor(current, { pageType: "SEARCH", pageUrl: current.targetUrl });
  assert.equal(result.changed, false);
  assert.equal(result.reason, "ALREADY_ARMED");
});

test("an explicit repair hold cannot be undone by a search-page heartbeat", () => {
  const current = { enabled: false, autoArmSuppressed: true, mode: "REAL_ADAPTER", targetUrl: "https://www.xiaohongshu.com/search_result?keyword=x" };
  const result = deriveAutomaticRankingMonitor(current, { pageType: "SEARCH", pageUrl: current.targetUrl });
  assert.equal(result.changed, false);
  assert.equal(result.reason, "AUTO_ARM_SUPPRESSED");
  assert.equal(result.config.autoArmSuppressed, true);
});
