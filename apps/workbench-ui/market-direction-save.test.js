import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { directionTerms } from "./market-trends.js";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("background market rerender keeps both unsaved direction inputs", () => {
  const body = app.match(/function renderMarket\(\) \{([\s\S]*?)\n\}\nfunction renderMarketDrill/)?.[1];
  assert.ok(body);
  const fields = new Map();
  const el = (id) => { if (!fields.has(id)) fields.set(id, { value: "", textContent: "", innerHTML: "", hidden: false }); return fields.get(id); };
  el("market-direction").value = "家庭收纳";
  el("market-terms").value = "衣柜整理";
  const context = {
    state: { marketState: { direction: "", preciseTerms: [], archives: [], favorites: [] }, marketHours: 24, marketExpanded: { all: false, direction: false }, liveRanking: { rows: [] }, marketDraftDirty: true },
    el, document: { activeElement: { id: "market-direction-form" } },
    buildMarketTopics: () => ({ all: [], direction: [], sampleCount: 0 }),
    marketTopicRows: () => "", renderMarketDrill() {}, esc: String,
  };
  context.document = {}; context.renderComparison = () => {};
  runInNewContext(`(() => {${body}\n})()`, context);
  assert.equal(el("market-direction").value, "家庭收纳");
  assert.equal(el("market-terms").value, "衣柜整理");
});

test("topic row shows its last update in the middle of the row", () => {
  const body = app.match(/function marketTopicRows\(topics, board\) \{([\s\S]*?)\n\}\nfunction renderMarket/)?.[1];
  assert.ok(body);
  const render = runInNewContext(`((topics, board) => {${body}\n})`, {
    esc: String, marketTrend: () => "<span>上升</span>", formatNumber: String,
    compactMarketTime: () => "9月25日 20:30",
  });
  const html = render([{ label: "家庭收纳", count: 2, coverage: 1, score: 12, lastUpdatedAt: "2026-09-25T11:30:00.000Z" }], "all");
  assert.match(html, /9月25日 20:30/);
  assert.match(html, /<time[^>]*datetime="2026-09-25T11:30:00.000Z"/);
});

test("both topic boards and the post drill use aligned column headings", () => {
  assert.match(app, /function marketTopicHeader\(/);
  assert.match(app, /marketTopicHeader\("all"\)/);
  assert.match(app, /marketTopicHeader\("direction"\)/);
  assert.match(app, /function marketPostHeader\(/);
  assert.match(app, /marketPostHeader\(\)/);
  assert.doesNotMatch(app, /market-topic-score">热度 /);
});

test("topic trends map rising to red and falling to green classes", () => {
  const body = app.match(/function marketTrend\(topic\) \{([\s\S]*?)\n\}\nfunction marketTopicHeader/)?.[1];
  assert.ok(body);
  const render = runInNewContext(`((topic) => {${body}\n})`, { formatNumber: String });
  assert.match(render({ trend: "UP", growth: 2 }), /market-trend up/);
  assert.match(render({ trend: "DOWN", growth: -2 }), /market-trend down/);
});

test("every ranking highlights the whole top-three row", () => {
  assert.ok(/market-topic-row[^`]*\$\{index < 3 \? "top-three"/.test(app));
  assert.ok(/market-post-row[^`]*\$\{index < 3 \? "top-three"/.test(app));
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.ok(css.includes(".live-ranking-table tbody tr:nth-child(-n+3)"));
});

test("saving a direction finishes the UI flow after the server accepts it", async () => {
  const body = app.match(/el\("market-direction-form"\)\.addEventListener\("submit", async \(event\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(body, "direction submit handler exists");
  const messages = [];
  const fields = {
    "market-direction": { value: "家庭收纳" },
    "market-terms": { value: "衣柜整理" },
    "seed-keywords": { value: "" },
    "market-direction-save": { disabled: false, textContent: "保存方向" },
  };
  const context = {
    el: (id) => fields[id],
    state: { marketState: null, marketDrill: null },
    api: async () => ({ direction: "家庭收纳", preciseTerms: ["衣柜整理"], archives: [], favorites: [] }),
    renderMarket() {},
    renderFavorites() {},
    saveDraft() {},
    directionFeedback() {},
    toast: (message, tone) => messages.push({ message, tone }),
  };
  if (/import\s*\{[^}]*\bdirectionTerms\b[^}]*\}\s*from\s*["']\.\/market-trends\.js["']/.test(app)) context.directionTerms = directionTerms;
  const submit = runInNewContext(`(async (event) => {${body}\n})`, context);
  await submit({ preventDefault() {} });
  assert.equal(messages.at(-1)?.tone, "success", JSON.stringify(messages));
  assert.match(fields["seed-keywords"].value, /家庭收纳/);
});

test("manual update dispatches a saved direction as a real keyword collection", () => {
  assert.match(app, /async function dispatchDirectionRefresh\(\)/);
  assert.match(app, /api\("\/api\/keywords\/plan"/);
  assert.match(app, /api\("\/api\/keywords\/run"/);
  const body = app.match(/async function runRealRefresh\(\) \{([\s\S]*?)\n\}\n\ndocument\.querySelectorAll/)?.[1];
  assert.ok(body);
  assert.match(body, /dispatchDirectionRefresh\(\)/);
  assert.match(body, /\/api\/ranking\/refresh/);
});

test("direction refresh plans saved terms and enables metric enrichment", async () => {
  const body = app.match(/async function dispatchDirectionRefresh\(\) \{([\s\S]*?)\n\}\n\nasync function runRealRefresh/)?.[1];
  assert.ok(body);
  const calls = [];
  const refresh = runInNewContext(`(async () => {${body}\n})`, {
    state: { marketState: { direction: "家庭收纳", preciseTerms: ["衣柜整理", "厨房整理"] }, runtime: { keywordRuns: [] } },
    el: () => ({ value: "100" }),
    api: async (path, options) => {
      const request = JSON.parse(options.body);
      calls.push({ path, request });
      return path.endsWith("/plan") ? { nodes: [{ keyword: "家庭收纳" }] } : { run: { runId: "direction-1" } };
    },
  });
  const receipt = await refresh();
  assert.equal(receipt.run.runId, "direction-1");
  assert.deepEqual(calls.map((call) => call.path), ["/api/keywords/plan", "/api/keywords/run"]);
  assert.match(calls[0].request.seeds, /家庭收纳\n衣柜整理\n厨房整理/);
  assert.ok(calls[0].request.noteDetailsPerKeyword >= 1);
  assert.equal(calls[1].request.settings.searchLimit, 100);
  assert.equal(calls[1].request.settings.autoCollectNotes, true);
  assert.equal(calls[1].request.settings.completeMetrics, true);
});

test("update saves a newly typed direction before dispatching its search", async () => {
  const body = app.match(/async function dispatchDirectionRefresh\(\) \{([\s\S]*?)\n\}\n\nasync function runRealRefresh/)?.[1];
  assert.ok(body);
  const fields = { "market-direction": { value: "厨房整理" }, "market-terms": { value: "冰箱收纳，备餐" }, "collection-target": { value: "50" } };
  const calls = [];
  const state = { marketDraftDirty: true, marketDraftRevision: 1, marketState: { direction: "家庭收纳", preciseTerms: [] }, runtime: { keywordRuns: [] } };
  const refresh = runInNewContext(`(async () => {${body}\n})`, {
    state, el: (id) => fields[id],
    api: async (path, options) => {
      const request = JSON.parse(options.body);
      calls.push({ path, request });
      if (path === "/api/market-state/direction") return { direction: request.direction, preciseTerms: request.preciseTerms };
      return path.endsWith("/plan") ? { nodes: [{ keyword: "厨房整理" }] } : { run: { runId: "direction-2" } };
    },
  });
  await refresh();
  assert.deepEqual(calls.map((call) => call.path), ["/api/market-state/direction", "/api/keywords/plan", "/api/keywords/run"]);
  assert.match(calls[1].request.seeds, /厨房整理\n冰箱收纳\n备餐/);
  assert.equal(state.marketDraftDirty, false);
});
