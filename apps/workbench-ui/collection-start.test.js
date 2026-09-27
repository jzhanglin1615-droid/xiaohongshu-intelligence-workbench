import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("a storage failure cannot hide a successfully dispatched collection", async () => {
  const body = app.match(/el\("keyword-form"\)\.addEventListener\("submit", async \(event\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(body);
  const fields = new Map(Object.entries({
    "seed-keywords": "收纳", "collection-target": "30", "search-scope": "CORE_SEEDS_ONLY", "max-depth": "0", "max-keywords": "20", "notes-per-keyword": "5", "request-interval": "1500", "slow-network-minutes": "5", "collection-method": "TOP_N",
  }).map(([key, value]) => [key, { value, textContent: "", disabled: false }]));
  const el = (id) => {
    if (!fields.has(id)) fields.set(id, { value: "", textContent: "", disabled: false });
    return fields.get(id);
  };
  const messages = [];
  const requests = [];
  const context = {
    el, saveDraft() { throw new Error("storage blocked"); },
    localStorage: { setItem() { throw new Error("storage blocked"); } },
    api: async (path) => { requests.push(path); return path.endsWith("/plan") ? { nodes: [{ keywordId: "a" }] } : { run: { runId: "run-1" }, dispatchedTasks: 1 }; },
    loadCore: async () => {}, readPlanHistory: () => [], renderPlanHistory() {},
    toast: (message, tone) => messages.push({ message, tone }), planHistoryKey: "history",
  };
  await runInNewContext(`(async (event) => {${body}\n})`, context)({ preventDefault() {} });
  assert.deepEqual(requests, ["/api/keywords/plan", "/api/keywords/run"]);
  assert.equal(messages.at(-1)?.tone, "success", JSON.stringify(messages));
});

test("all visible update buttons share one refresh and sync reloads all views", () => {
  for (const id of ["refresh", "live-ranking-refresh", "history-refresh"]) {
    assert.match(app, new RegExp(`el\\("${id}"\\)\\.addEventListener\\("click", runRealRefresh\\)`));
  }
  assert.match(app, /async function syncAllViews\(\)[\s\S]*?Promise\.all\(\[loadCore\(\), loadViewHistory\(\), loadConnections\(\), loadProviders\(\)\]\)/);
  assert.match(app, /el\("sync"\)[\s\S]*?await syncAllViews\(\)/);
});
