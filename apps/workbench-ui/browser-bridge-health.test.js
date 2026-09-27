import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBrowserHeartbeat, sanitizeHeartbeatPageUrl, summarizeBrowserBridge } from "./browser-bridge-health.js";

test("heartbeat URLs retain the visible path but remove query tokens and fragments", () => {
  assert.equal(sanitizeHeartbeatPageUrl("https://www.xiaohongshu.com/explore/note-1?xsec_token=secret&source=web#comment"), "https://www.xiaohongshu.com/explore/note-1");
  assert.equal(sanitizeHeartbeatPageUrl("https://www.xiaohongshu.com/search_result?keyword=%E7%BE%8E%E9%A3%9F&xsec_token=secret#results"), "https://www.xiaohongshu.com/search_result?keyword=%E7%BE%8E%E9%A3%9F");
  assert.throws(() => sanitizeHeartbeatPageUrl("https://example.com/?token=secret"), /INVALID_HEARTBEAT_PAGE_URL/);
});

test("heartbeat normalization is bounded and only accepts declared capabilities", () => {
  const heartbeat = normalizeBrowserHeartbeat({ clientId: "extension-12345678", extensionVersion: "0.4.0", contentScriptVersion: "0.4.0", pageType: "NOTE_DETAIL", pageUrl: "https://www.xiaohongshu.com/explore/1?xsec_token=secret", capabilities: ["commentTraversal", "visibleReadOnly", "cookieExport", "commentTraversal"], autoRunStatus: "RUNNING" }, "2026-09-25T00:00:00.000Z");
  assert.deepEqual(heartbeat.capabilities, ["commentTraversal", "visibleReadOnly"]);
  assert.equal(heartbeat.pageUrl, "https://www.xiaohongshu.com/explore/1");
  assert.equal(heartbeat.versionStatus, "MATCHED");
});

test("heartbeat exposes a stale page script instead of reporting a false upgrade", () => {
  const stale = normalizeBrowserHeartbeat({ clientId: "extension-12345678", extensionVersion: "0.5.8", contentScriptVersion: "0.5.6", pageType: "SEARCH", pageUrl: "https://www.xiaohongshu.com/search_result?keyword=test" });
  assert.equal(stale.versionStatus, "RELOAD_REQUIRED");
  assert.equal(stale.contentScriptVersion, "0.5.6");
});

test("bridge health distinguishes live, stale, and never-connected extension states", () => {
  const runtime = { browserBridge: { clients: [{ clientId: "extension-12345678", receivedAt: "2026-09-25T00:00:00.000Z" }] } };
  assert.equal(summarizeBrowserBridge(runtime, "2026-09-25T00:00:30.000Z").connectionStatus, "CONNECTED");
  assert.equal(summarizeBrowserBridge(runtime, "2026-09-25T00:01:00.000Z").connectionStatus, "STALE");
  assert.equal(summarizeBrowserBridge({}, "2026-09-25T00:01:00.000Z").connectionStatus, "NOT_CONNECTED");
});

test("invalid browser identities and extension versions fail closed", () => {
  assert.throws(() => normalizeBrowserHeartbeat({ clientId: "browser", extensionVersion: "0.4.0" }), /INVALID_BROWSER_CLIENT_ID/);
  assert.throws(() => normalizeBrowserHeartbeat({ clientId: "extension-12345678", extensionVersion: "latest" }), /INVALID_EXTENSION_VERSION/);
  assert.throws(() => normalizeBrowserHeartbeat({ clientId: "extension-12345678", extensionVersion: "0.5.8", contentScriptVersion: "old" }), /INVALID_CONTENT_SCRIPT_VERSION/);
});
