import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("./content-script.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("browser panel presents the canonical collection progress used by the workbench", async () => {
  const source = script.match(/const refreshRun = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(source);
  const elements = new Map();
  const role = (name) => {
    if (!elements.has(name)) elements.set(name, { innerHTML: "", textContent: "", style: {}, setAttribute(key, value) { this[key] = value; } });
    return elements.get(name);
  };
  const requests = [];
  const run = { runId: "keyword-1", status: "SUCCEEDED", settings: { searchLimit: 30 }, counters: { admittedCards: 30, discoveredCandidates: 36, total: 1, succeeded: 1 } };
  const context = { role, document: { activeElement: null }, send: async (request) => { requests.push(request.kind); return { ok: true, value: { runKind: "KEYWORD", run, active: false, target: 30, admitted: 30, discovered: 36, completed: 1, total: 1, percent: 100 } }; }, runStatusLabels: { SUCCEEDED: "已完成" }, cachedAutoState: null };
  await runInNewContext(`(async () => {${source}\n})`, context)();
  assert.deepEqual(requests, ["GET_COLLECTION_PROGRESS"]);
  assert.match(role("run").innerHTML, /30\/30/);
  assert.equal(role("progress-track")["aria-valuenow"], "100");
});

test("browser panel marks a terminal 23/30 run as below target and exposes workbench facts", async () => {
  const source = script.match(/const refreshRun = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(source);
  const elements = new Map();
  const role = (name) => {
    if (!elements.has(name)) elements.set(name, { innerHTML: "", textContent: "", style: {}, setAttribute(key, value) { this[key] = value; } });
    return elements.get(name);
  };
  const run = { runId: "keyword-23", status: "SUCCEEDED", phase: "关键词采集", currentKeyword: null, settings: { searchLimit: 30, maxDepth: 1 }, counters: { admittedCards: 23, discoveredCandidates: 27, savedNotes: 0, total: 1, succeeded: 1 }, keywords: [{ keywordId: "one", value: "测试词" }] };
  const progress = { runKind: "KEYWORD", run, active: false, target: 30, admitted: 23, discovered: 27, completed: 1, total: 1, percent: 77 };
  const context = { role, document: { activeElement: null }, send: async () => ({ ok: true, value: progress }), runStatusLabels: { SUCCEEDED: "已完成" }, latestCollectionProgress: null, runSyncSucceeded: false, cachedAutoState: { enabled: true, status: "RUNNING" }, showAuto: () => {} };
  await runInNewContext(`(async () => {${source}\n})`, context)();
  assert.match(role("collection-status").textContent, /已结束·未达目标/);
  assert.equal(role("collection-keyword-count").textContent, "23/30");
  assert.equal(role("collection-seed-progress").textContent, "1/1");
  assert.equal(role("collection-depth").textContent, "1");
  assert.match(role("progress-copy").textContent, /未达目标/);
  assert.equal(role("progress-track")["aria-valuenow"], "77");
  assert.equal(role("pause").disabled, true);
  assert.equal(role("resume").disabled, true);
});

test("automatic mode stays enabled but does not claim to be collecting after a terminal run", () => {
  const source = script.match(/const showAuto = \(state\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(source);
  const auto = { innerHTML: "" };
  const buttons = new Map();
  const context = { role: () => auto, panel: { querySelector: (selector) => { if (!buttons.has(selector)) buttons.set(selector, {}); return buttons.get(selector); } }, runSyncSucceeded: true, latestCollectionProgress: { active: false }, cachedAutoState: null };
  runInNewContext(`((state) => {${source}\n})`, context)({ enabled: true, status: "RUNNING" });
  assert.match(auto.innerHTML, /已开启·待命/);
  assert.doesNotMatch(auto.innerHTML, /<strong>运行中<\/strong>/);
  assert.equal(buttons.get("[data-action='auto-start']").disabled, true);
  assert.equal(buttons.get("[data-action='auto-stop']").disabled, false);
});
