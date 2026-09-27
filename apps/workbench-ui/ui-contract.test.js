import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const extension = readFileSync(new URL("../browser-extension/content-script.js", import.meta.url), "utf8");
const extensionWorker = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
const extensionManifest = readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8");
const visibleViews = ["overview", "collection", "database", "history", "models"];
const internalViews = ["connections"];

test("the navigation exposes the automatic collector while technical connections stay hidden", () => {
  for (const view of visibleViews) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`data-view-panel="${view}"`));
  }
  for (const view of internalViews) {
    assert.doesNotMatch(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`data-view-panel="${view}"[^>]*hidden`));
  }
});

test("the primary navigation is reduced to four core hubs", () => {
  const navigation = html.match(/<nav class="primary-nav">[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.equal((navigation.match(/data-view=/g) ?? []).length, 4);
  for (const view of ["overview", "collection", "database", "history"]) assert.match(navigation, new RegExp(`data-view="${view}"`));
  for (const view of ["ranking", "analysis", "decision", "models"]) assert.doesNotMatch(navigation, new RegExp(`data-view="${view}"`));
});

test("sync and update are distinct, and the ranking stays compact", () => {
  assert.match(html, /id="sync"/);
  assert.match(html, /id="refresh"/);
  assert.match(app, /el\("sync"\)\.addEventListener\("click"/);
  assert.match(app, /el\("refresh"\)\.addEventListener\("click", runRealRefresh\)/);
  assert.match(html, /id="ranking-more"/);
  assert.match(app, /rows\.slice\(0, state\.rankingExpanded \? undefined : 10\)/);
  assert.match(html, /id="collection-target"[^>]*max="10000"/);
  assert.match(html, /<section hidden aria-hidden="true"><div id="decision-cards"><\/div><\/section>/);
});

test("topic drill is located with its source board and can collapse without disappearing", () => {
  assert.match(app, /el\(`market-\$\{selection\.board === "direction" \? "direction" : "all"\}-topics`\)\.closest\("\.market-board"\)\.after\(el\("market-drill"\)\)/);
  assert.match(app, /marketDrillCollapsed/);
  assert.doesNotMatch(app, /el\("market-drill-close"\)\.addEventListener\("click", \(\) => \{ state\.marketDrill = null/);
});

test("ranking headers and values share fixed columns, including missing covers", () => {
  assert.match(styles, /\.market-post-header,\.market-post-row\{grid-template-columns:/);
  assert.match(styles, /\.market-post-metrics,\.market-post-metrics-header\{display:grid;grid-template-columns:repeat\(3,/);
  assert.match(styles, /\.live-ranking-table\{min-width:\d+px;table-layout:fixed\}/);
  assert.match(app, /post-cover post-cover-missing/);
  assert.match(app, /market-post-metrics-header/);
});

test("the collection panel exposes the settings visible in the reference video", () => {
  const requiredIds = [
    "seed-keywords",
    "max-depth",
    "max-keywords",
    "notes-per-keyword",
    "collection-comment-limit",
    "request-interval",
    "slow-network-minutes",
    "search-scope",
    "collection-method",
    "auto-collect-notes",
    "keyword-file",
    "plan-history",
    "dispatch-keyword-run",
    "collection-progress-fill",
    "collection-live-card",
    "collection-stage",
    "collection-seed-progress",
    "collection-related-count",
    "collection-total-note-count",
    "collection-depth",
    "collect-notes",
    "collection-opportunities",
    "collection-accounts",
    "collection-history",
  ];
  for (const id of requiredIds) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, `${id} must exist exactly once`);
  }
  assert.match(app, /\/api\/research-runs/);
  assert.match(server, /\/api\/research-runs/);
  assert.match(server, /\/api\/research-export/);
  assert.match(app, /collection-live-card/);
  assert.match(app, /aria-valuenow/);
});

test("all static DOM ids used by app.js exist in index.html", () => {
  const referencedIds = [...app.matchAll(/\bel\("([^"]+)"\)/g)].map((match) => match[1]);
  const missing = [...new Set(referencedIds)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("deep links and current-page semantics are explicit", () => {
  assert.match(app, /location\.hash\.slice\(1\)/);
  assert.match(app, /addEventListener\("hashchange"/);
  assert.match(app, /setAttribute\("aria-current", "page"\)/);
});

test("every deeper workspace view has a visible in-app return path", () => {
  assert.match(html, /id="view-back"/);
  assert.match(html, /返回上一层/);
  assert.match(app, /function returnToPreviousView/);
  assert.match(app, /detailParentView/);
  assert.doesNotMatch(app, /viewTrail/);
  assert.match(app, /viewScroll/);
  assert.match(app, /replaceHash: true/);
});

test("the user-facing home, live ranking, and analysis show concrete operational outputs", () => {
  for (const id of ["today-headline", "today-actions", "sector-grid", "live-ranking-rows", "analysis-cards"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /点赞/);
  assert.match(html, /收藏/);
  assert.match(html, /评论/);
  assert.match(html, /转发/);
  assert.doesNotMatch(html.match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? "", /采集运行|连接与同步|预警闭环/);
});

test("the shell distinguishes active capture from presence-gated hourly checks", () => {
  assert.match(app, /monitor\.captureActive === true/);
  assert.match(app, /使用期间每小时检查/);
  assert.match(app, /\/api\/workbench-presence/);
  assert.match(app, /等待下次检查/);
});

test("the unified recommendation, clickable detail and filterable history form one workflow", () => {
  for (const id of ["database-suggestions", "topic-filters", "detail-content", "history-search", "history-source", "history-selected", "history-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.equal((html.match(/data-recommendation/g) ?? []).length, 1);
  assert.match(app, /buildContentRecommendation/);
  assert.match(app, /openNoteDetail/);
  assert.match(app, /\/api\/view-history/);
  assert.match(server, /\/api\/view-history/);
  assert.match(app, /pollRuntimeStatus/);
  assert.match(app, /setInterval[\s\S]*2000/);
  assert.match(app, /\/api\/runtime-summary/);
  assert.match(server, /\/api\/runtime-summary/);
  assert.match(extension, /SUBMIT_SEARCH_PROGRESS/);
  assert.match(app, /\/api\/keywords\/plan/);
  assert.match(app, /\/api\/keywords\/run/);
});

test("ranking focuses on likes, saves and shares and is merged into the opportunity hub", () => {
  const rankingSection = html.match(/id="opportunity-ranking"[\s\S]*?<\/article>/)?.[0] ?? "";
  assert.match(rankingSection, /<th>点赞<\/th>/);
  assert.match(rankingSection, /<th>收藏<\/th>/);
  assert.match(rankingSection, /<th>转发<\/th>/);
  assert.doesNotMatch(rankingSection, /<th>评论<\/th>/);
  assert.match(app, /metricDelta/);
  assert.match(app, /数据变化/);
});

test("history supports deleting one record and clearing all records", () => {
  assert.match(html, /id="history-clear"/);
  assert.match(app, /delete-history/);
  assert.match(app, /method: "DELETE"/);
  assert.match(server, /request\.method === "DELETE" && url\.pathname === "\/api\/view-history"/);
  assert.match(server, /VIEW_HISTORY_NOTE_NOT_FOUND/);
});

test("automatic topic selection and refresh feedback are visible", () => {
  assert.match(html, /智能自动选题/);
  assert.match(app, /buildAutoTopics/);
  assert.match(app, /auto-topic-score/);
  assert.match(html, /id="refresh-feedback"/);
  assert.match(app, /pendingRefreshFeedback/);
  assert.match(readFileSync(new URL("./refresh-coordinator.js", import.meta.url), "utf8"), /暂无数据变化/);
});

test("the browser overlay owns the pull target and keeps background collection awake", () => {
  assert.match(extension, /data-role="search-limit"/);
  assert.match(extension, /SET_COLLECTION_SETTINGS/);
  assert.match(extension, /effectiveSearchLimit/);
  assert.match(extension, /BACKGROUND_COLLECTION_TICK/);
  assert.doesNotMatch(extension, /Math\.min\(1500/);
  assert.match(extensionWorker, /chrome\.alarms\.create/);
  assert.match(extensionWorker, /chrome\.tabs\.sendMessage/);
  assert.match(extensionManifest, /"alarms"/);
});

test("live collection data refreshes on progress and immediately after returning to the app", () => {
  assert.match(app, /runtime\?\.rankingMonitor\?\.captureActive === true/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /正在同步后台采集结果/);
  assert.match(app, /已读取本地快照/);
  assert.match(app, /loadRuntimeSummary/);
});

test("the live collection card can request note enrichment without leaving the task", () => {
  assert.match(html, /id="collect-notes"/);
  assert.match(app, /action: "ENRICH"/);
  assert.match(server, /action === "ENRICH"/);
  assert.match(server, /autoCollectNotes/);
});

test("today, breakdown and production views use focused progressive layouts", () => {
  assert.match(app, /today-focus-card/);
  assert.match(app, /analysis-summary/);
  assert.match(app, /decision-priority/);
  assert.match(html, /现在什么值得做/);
});

test("detail and collection results expose useful media and honest admission state", () => {
  assert.match(app, /function renderDetailAssets/);
  assert.match(app, /作品素材/);
  assert.match(app, /候选已入台，部分补证未完成/);
  assert.match(app, /已发现候选仍保留在采集台/);
  assert.match(app, /候选已经进入采集台；素材与正文按需补证/);
});

test("comment traversal is supplemental and never blocks viral candidate admission", () => {
  assert.match(server, /rankingRun\.settings\.completeMetrics \? \["DETAIL_LIKES_MISSING", "DETAIL_COLLECTS_MISSING", "DETAIL_SHARES_MISSING"\]\.includes\(gap\) : !String\(gap\)\.startsWith\("COMMENT_"\)/);
  assert.match(extension, /评论补证停滞，点赞\/收藏\/转发仍会正常入台/);
  assert.match(extension, /commentTraversalSkipped = true;[\s\S]*?traversal = \{ action: "COMPLETE" \}/);
});

test("the model connector accepts a key, verifies it, retrieves models and powers shared analysis", () => {
  assert.match(app, /data-field="apiKey"/);
  assert.match(app, /测试连接并读取模型/);
  assert.match(app, /provider\?\.verified/);
  assert.match(app, /enhanceRecommendation/);
  assert.match(app, /\/api\/model\/analyze/);
  assert.match(server, /body\.apiKey/);
  assert.match(server, /providerVerification/);
  const saveProviderBody = app.match(/async function saveProvider\(card, \{ quiet = false \} = \{\}\) \{([\s\S]*?)\n\}\nasync function updateModelApiMode/)?.[1] ?? "";
  assert.match(saveProviderBody, /await api\(`\/api\/providers\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(saveProviderBody, /Promise\.all/);
  assert.match(app, /async function testModelInference\(provider, modelId\)/);
  assert.match(app, /result\.parsedJson\?\.ok !== true/);
  assert.match(app, /模型列表不等于推理可用/);
  assert.match(app, /data-manual-model/);
  assert.match(app, /await saveProvider\(card, \{ quiet: true \}\)/);
  assert.match(app, /if \(!window\.confirm\("这会向该模型服务发出一次真实联网请求/);
  const pullBody = app.match(/async function pullModels\(card\) \{([\s\S]*?)\n\}\nasync function useSimpleModel/)?.[1] ?? "";
  assert.ok(pullBody.indexOf("window.confirm") < pullBody.indexOf("saveProvider(card, { quiet: true })"));
  assert.match(pullBody, /AbortController/);
  assert.match(pullBody, /clearTimeout\(timer\)/);
  assert.doesNotMatch(pullBody, /toast\("连接信息已保存/);
  assert.match(html, /id="history-refresh" type="button" hidden/);
});

test("model API switch gates outbound model calls while retaining normal collection", () => {
  assert.match(app, /id="model-api-enabled"/);
  assert.match(app, /普通联网采集照常运行/);
  assert.match(app, /\/api\/model-api-mode/);
  assert.match(app, /\/credentials/);
  assert.match(server, /const requireModelApiEnabled/);
  assert.match(server, /await requireModelApiEnabled\(\);[\s\S]*?gateway\.listModels/);
  assert.match(server, /await requireModelApiEnabled\(\);[\s\S]*?gateway\.analyze/);
  assert.match(server, /await initializeModelSettings\(\)/);
});

test("the interface does not use an em dash as an unexplained missing value", () => {
  assert.doesNotMatch(html, /—/);
  assert.doesNotMatch(app, /\?\?\s*"—"/);
});

test("the database view exposes real SQLite search, health, tags, saved views, safe restore, and export controls", () => {
  for (const id of ["database-health", "database-search", "database-tag-filter", "database-view", "apply-database-view", "save-database-view", "database-restore-file", "database-restore-status", "restore-database"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /\/api\/database\/notes/);
  assert.match(app, /\/api\/database\/views/);
  assert.match(app, /\/api\/database\/restore\?confirm=true/);
  assert.match(app, /window\.confirm/);
  assert.match(html, /真实 JSON/);
  assert.match(html, /真实 CSV/);
  assert.match(html, /研究包/);
  assert.match(html, /备份 SQLite/);
});

test("the connections view exposes live browser-bridge readiness instead of inferring it from old evidence", () => {
  for (const id of ["bridge-connection-status", "bridge-health-details", "field-validation-status", "field-validation-details", "human-comparison-form", "human-comparison-source-url", "human-comparison-reviewer", "human-comparison-confirmed", "human-comparison-fields", "human-comparison-submit", "human-comparison-result"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /connectionStatus/);
  assert.match(app, /NOT_CONNECTED/);
  assert.match(app, /STALE/);
  assert.match(app, /CONNECTED/);
  assert.match(app, /state\.runtime\?\.browserBridge/);
  assert.match(server, /\/api\/browser-bridge\/status/);
  assert.match(server, /\/api\/browser-bridge\/field-validation\/latest/);
  assert.match(server, /human-comparison/);
  assert.match(app, /READY_FOR_HUMAN_COMPARE/);
  assert.match(app, /CONTRACT_ONLY/);
  assert.match(app, /REAL_VISIBLE_PAGE/);
  assert.match(app, /humanComparisonStatus/);
});
