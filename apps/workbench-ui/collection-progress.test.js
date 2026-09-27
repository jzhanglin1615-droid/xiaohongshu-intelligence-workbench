import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("a completed keyword collection keeps progress visible in the overview control strip", () => {
  const source = app.match(/function renderCollection\(\) \{([\s\S]*?)\n\}\nfunction renderBrowserTasks/)?.[1];
  assert.ok(source);
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: id === "collection-live-card", dataset: {}, style: {}, setAttribute(name, value) { this[name] = value; } });
    return elements.get(id);
  };
  const run = { runId: "keyword-1", status: "SUCCEEDED", settings: { searchLimit: 30, maxDepth: 1 }, counters: { admittedCards: 30, discoveredCandidates: 36, total: 1, succeeded: 1 }, keywords: [{ keywordId: "word-1", value: "收纳" }], phase: "关键词采集" };
  const context = { el, state: { runtime: { keywordRuns: [run], browserTasks: [] }, liveRanking: { rows: [] }, collectionCardExpanded: false }, formatNumber: String, esc: String, renderBrowserTasks() {}, renderResearchWorkspace() {} };
  context.document = {}; context.renderCompleteness = () => {};
  runInNewContext(`(function renderCollection() {${source}\n})`, context)();
  assert.equal(el("collection-live-card").hidden, false);
  assert.equal(el("collection-card-expand").hidden, true);
  assert.equal(el("collection-progress-track")["aria-valuenow"], "100");
  assert.match(el("collection-progress-text").textContent, /30\/30/);
});
