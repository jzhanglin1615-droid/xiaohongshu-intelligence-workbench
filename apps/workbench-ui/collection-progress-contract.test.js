import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const extension = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = server.match(/function currentCollectionProgress\(runtime\) \{([\s\S]*?)\n\}\n\nasync function saveCollectionHistory/)?.[1];
assert.ok(source);
const progressFor = (runtime) => runInNewContext(`(function currentCollectionProgress(runtime) {${source}\n})`, {})(runtime);

test("active ranking run wins over a completed keyword run on both surfaces", () => {
  const keyword = { runId: "keyword-1", createdAt: "2026-09-25T00:00:00Z", status: "SUCCEEDED", settings: { searchLimit: 30 }, counters: { admittedCards: 30, discoveredCandidates: 36, succeeded: 1, total: 1 } };
  const ranking = { runId: "ranking-1", createdAt: "2026-09-25T00:10:00Z", status: "RUNNING", settings: { searchLimit: 100 }, counters: { ingestedCandidates: 27, discoveredCandidates: 38, succeeded: 0, total: 1 } };
  const progress = progressFor({ keywordRuns: [keyword], rankingRuns: [ranking] });
  assert.equal(progress.runKind, "RANKING");
  assert.equal(progress.run.runId, "ranking-1");
  assert.equal(progress.admitted, 27);
  assert.equal(progress.target, 100);
  assert.equal(progress.percent, 27);
  assert.match(app, /const job = progress\?\.run/);
  assert.match(extension, /request\("\/api\/collection\/progress"\)/);
});

test("extension target and controls route through the same active collection contract", () => {
  assert.match(extension, /request\("\/api\/collection\/target"/);
  assert.match(extension, /message\.runKind === "KEYWORD" \? "\/api\/keywords\/run\/control" : message\.runKind === "RANKING" \? "\/api\/ranking\/run\/control"/);
  assert.match(server, /url\.pathname === "\/api\/collection\/target"/);
  assert.match(server, /progress\.runKind === "KEYWORD" \? reconcileKeywordBrowserRun\(run/);
});
