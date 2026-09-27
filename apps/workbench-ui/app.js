import { parseKeywordTaskFile } from "./task-file-parser.js";
import { admittedWorkbenchNoteIds, buildLiveRanking } from "./live-ranking.js";
import { buildContentRecommendation } from "./content-recommendation.js";
import { buildAutoTopics } from "./topic-intelligence.js";
import { describeRefreshOutcome } from "./refresh-feedback.js";
import { buildMarketTopics, directionTerms } from "./market-trends.js";
import { rankingFacts, rankingCoverage } from "./ranking-evidence.js";
import { createRefreshCoordinator, pendingRefreshFeedback } from "./refresh-coordinator.js";
import { buildResearchWorkspace } from "./research-workspace.js";
import { mountWorkComparison } from "./work-comparison.js";
import { referenceExcerpt } from "./research-reference.js";
import { renderComparison, renderMetricTimeline, renderCompleteness } from "./evidence-charts.js";

const refreshCoordinator = createRefreshCoordinator();
// Unsaved secrets live only in memory, never in browser storage or HTML attributes.
const providerDrafts = new Map();

const state = { report: null, database: null, liveDatabase: null, admittedNoteIds: new Set(), liveSearchNotes: null, liveRanking: null, autoTopics: [], recommendation: null, modelInsight: null, projectState: null, marketState: null, marketHours: 24, marketExpanded: { all: false, direction: false }, marketDrill: null, marketDrillExpanded: false, marketDrillCollapsed: false, marketDraftDirty: false, marketDraftRevision: 0, viewHistory: [], databaseStatus: null, databaseViews: [], runtime: null, providers: null, connections: null, modelCatalogs: {}, selectedProviderId: null, modelInference: null, filter: "ALL", topicFilter: "ALL", selectedId: null, view: "overview", detailParentView: null, viewScroll: {}, collectionPoll: null, keywordPlan: null, realRefreshActive: false, coreLoading: null, lastCoreLoadedAt: 0, runtimeSignature: "", rankingSignature: "", pendingRefresh: null, collectionCardExpanded: false, rankingExpanded: false };
const draftKey = "xhs-workbench-keyword-draft-v1";
const planHistoryKey = "xhs-workbench-plan-history-v1";
const pages = {
  overview: ["市场雷达", "趋势与榜单", "先看选题方向，再看具体帖子"], collection: ["爆款搜罗", "自动采集", "发现即进入候选台"], database: ["内容资产", "我的收藏", "只保存主动选择的帖子"], history: ["浏览记录", "资料库", "可筛选可返回"], detail: ["内容详情", "帖子数据变化", "真实采集证据"], connections: ["后台能力", "连接状态", "系统自动管理"], models: ["能力连接", "连接分析模型", "一次设置即可"],
};
const viewAliases = { ranking: "overview", analysis: "database", decision: "database" };
const taskLabels = { EXTRACT: "信息抽取", SCREEN: "快速筛选", DEEP_ANALYSIS: "深度分析", VERIFY: "事实核验", DECISION_SUPPORT: "内容决策" };
const el = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatNumber = (value) => value === null || value === undefined ? "缺失" : new Intl.NumberFormat("zh-CN").format(value);
const percentage = (value) => `${Math.round(value * 100)}%`;
const statusLabel = (status) => ({ ELIGIBLE: "可解读", BLOCKED: "已阻断", INSUFFICIENT_EVIDENCE: "证据不足", COMPLETE: "完整", PARTIAL: "部分" }[status] ?? status);

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(url, { cache: "no-store", ...options, signal: options.signal ?? controller.signal, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求等待超过 90 秒；后台任务可能仍在进行，请先同步状态，勿重复启动");
    throw error;
  } finally { clearTimeout(timeout); }
}
function toast(message, tone = "info") {
  el("toast").textContent = message; el("toast").className = `toast show ${tone}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el("toast").className = "toast"; }, 4200);
}
function setNotice(title, message, tone = "warn") {
  el("notice").className = `notice ${tone}`; el("notice").innerHTML = `<strong>${esc(title)}</strong><span>${esc(message)}</span>`;
  el("notice").hidden = !["overview", "collection"].includes(state.view) && tone !== "error";
}
function noteFor(id) { return state.report.notes.find((note) => note.noteId === id); }
function completenessFor(id) { return state.report.completeness.find((item) => item.noteId === id); }
function assessmentFor(id) { return state.report.assessments.find((item) => item.noteId === id); }

function switchView(requestedView, options = {}) {
  const aliasedView = viewAliases[requestedView] ?? requestedView;
  const view = Object.hasOwn(pages, aliasedView) ? aliasedView : "overview";
  const previousView = state.view;
  if (previousView !== view) {
    state.viewScroll[previousView] = window.scrollY;
  }
  state.view = view;
  el("notice").hidden = !["overview", "collection"].includes(view) && !el("notice").classList.contains("error");
  (view === "overview" ? el("market-refresh-host") : el("topbar-refresh-host")).append(el("top-actions"));
  (view === "collection" ? el("collection-control-host") : el("market-control-host")).append(el("collection-live-card"));
  document.querySelector(".ranking-shortcuts").hidden = view !== "overview";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const [kicker, title, scope] = pages[view]; el("page-kicker").textContent = kicker; el("page-title").textContent = title; el("scope-chip").textContent = scope;
  const backTarget = view === "detail" && Object.hasOwn(pages, state.detailParentView) ? state.detailParentView : null;
  el("view-back").hidden = !backTarget;
  el("view-back").textContent = backTarget ? `← 返回${pages[backTarget][1]}` : "← 返回";
  if (options.updateHash !== false && location.hash !== `#${view}`) {
    if (options.replaceHash === true) history.replaceState(null, "", `#${view}`);
    else history.pushState(null, "", `#${view}`);
  }
  if (options.restoreScroll !== false) requestAnimationFrame(() => window.scrollTo({ top: state.viewScroll[view] ?? 0, behavior: "instant" }));
  refreshView(view);
}

function returnToPreviousView() {
  if (state.view !== "detail") return;
  const parentView = Object.hasOwn(pages, state.detailParentView) ? state.detailParentView : "overview";
  state.detailParentView = null;
  switchView(parentView, { replaceHash: true });
}

function liveNoteFor(id) { return state.admittedNoteIds.has(id) ? (state.liveDatabase?.notes ?? []).find((note) => note.noteId === id) : null; }
function practicalAngle(row, note) {
  const title = row.title.replace(/[｜|丨].*$/, "").trim();
  const topic = note?.keywords?.[0] || title.slice(0, 18);
  return `保留“${topic}”这个需求，换成你的真实经历、步骤或对比结果。`;
}
function relativeBar(value, rows, key) {
  if (value === null || value === undefined) return 0;
  const max = Math.max(1, ...rows.map((row) => row[key] ?? 0));
  return Math.max(4, Math.round(value / max * 100));
}
function rankSparkline(row) {
  const points = row.rankHistory ?? [];
  if (points.length < 2) return "";
  const width = 90; const height = 28; const ranks = points.map((item) => item.rank); const min = Math.min(...ranks); const max = Math.max(...ranks); const range = Math.max(1, max - min);
  const path = points.map((item, index) => `${index ? "L" : "M"}${Math.round(index / (points.length - 1) * width)},${Math.round((item.rank - min) / range * (height - 6) + 3)}`).join(" ");
  return `<span class="rank-spark"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="排名变化"><path d="${path}" /></svg><small>${points.length} 次快照</small></span>`;
}
function hasThreeMetrics(row) { return rankingFacts(row).complete; }
function rankingEvidence(row) {
  const facts = rankingFacts(row);
  const rankChange = facts.rankChange;
  const trend = row.trend === "RISING" && rankChange > 0 ? `<span class="evidence-up">↑ ${rankChange} 位</span>` : row.trend === "FALLING" && rankChange > 0 ? `<span class="evidence-down">↓ ${rankChange} 位</span>` : row.trend === "NEW_ENTRY" ? "新入榜" : "在榜";
  const saveRate = facts.collectLikeRatio === null ? "藏赞比不可计算" : `藏赞比 ${(facts.collectLikeRatio * 100).toFixed(1)}%`;
  return `<div class="ranking-evidence"><strong>${trend}</strong><small title="藏赞比 = 收藏数 ÷ 点赞数；三项互动合计不代表独立用户数">${saveRate} · 三项互动 ${formatNumber(facts.interactions)}</small></div>${rankSparkline(row)}`;
}
function pendingCandidates(rows, { open = false, limit = 10 } = {}) {
  const pending = rows.filter((row) => !hasThreeMetrics(row));
  if (!pending.length) return "";
  return `<details class="pending-candidates" ${open ? "open" : ""}><summary>待补数据 ${pending.length} 条 · 已采集，尚未进入完整数据榜</summary><p>可查看已有证据，再按需打开详情补数据；平台未提供的指标不能保证补齐。</p>${pending.slice(0, limit).map((row) => `<div class="pending-candidate"><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button">${esc(row.title)}</button><span>缺少：${rankingFacts(row).missing.join("、")}</span><button class="secondary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">查看数据</button></div>`).join("")}${pending.length > limit ? `<button class="secondary" type="button" data-pending-more>再看 10 条（剩余 ${pending.length - limit} 条）</button>` : ""}${limit > 10 ? `<button class="secondary" type="button" data-pending-reset>仅显示前 10 条</button>` : ""}</details>`;
}
function metricDeltaLabel(row, key) {
  const delta = row.metricDelta?.[key];
  if (delta === null || delta === undefined) return `<small class="metric-change flat">—</small>`;
  const value = Number(delta);
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  return `<small class="metric-change ${value > 0 ? "positive" : value < 0 ? "negative" : "flat"}" aria-label="${value > 0 ? "上升" : value < 0 ? "下降" : "不变"} ${formatNumber(Math.abs(value))}">${arrow}${formatNumber(Math.abs(value))}</small>`;
}
function rankingDataSignature(ranking) {
  return JSON.stringify((ranking?.rows ?? []).map((row) => [row.noteId, row.likes, row.collects, row.shares, row.observedAt, row.lastSeenAt, row.sourceScope, row.sourceRank]));
}
function setRefreshFeedback(message, tone = "") {
  const target = el("refresh-feedback");
  target.textContent = message;
  target.className = tone;
}
function renderSharedRecommendation() {
  const recommendation = state.recommendation;
  document.querySelectorAll("[data-recommendation]").forEach((target) => {
    if (!recommendation?.topPick) {
      target.innerHTML = `<article class="panel recommendation-card empty-recommendation"><div><span class="recommendation-label">${esc(recommendation?.label ?? "暂不推荐")}</span><h2>${esc(recommendation?.title ?? "等待真实数据")}</h2><p>${esc(recommendation?.guidance ?? "采集后自动形成统一建议。")}</p></div></article>`;
      return;
    }
    const row = recommendation.topPick; const rows = state.liveRanking?.rows ?? [];
    const insight = state.modelInsight?.noteId === row.noteId ? state.modelInsight : null;
    target.innerHTML = `<article class="panel recommendation-card"><div class="recommendation-copy"><div class="recommendation-meta"><span class="recommendation-label">${esc(recommendation.label)}</span><span>${esc(recommendation.accountFitStatus)}</span><span>置信度 ${esc(recommendation.confidence)}</span></div><h2>${esc(recommendation.title)}</h2><p>${esc(recommendation.guidance)}</p><div class="evidence-chips">${row.evidenceReasons.map((item) => `<span>${esc(item)}</span>`).join("")}</div>${insight ? `<div class="model-insight"><span>模型补充判断</span><strong>${esc(insight.recommendedAngle || insight.whyItWorks || "已完成增强分析")}</strong>${Array.isArray(insight.executionSteps) ? `<ol>${insight.executionSteps.slice(0, 3).map((item) => `<li>${esc(item)}</li>`).join("")}</ol>` : ""}<small>${esc(insight.providerId)} · ${esc(insight.modelId)} · ${new Date(insight.finishedAt).toLocaleString("zh-CN")}</small></div>` : ""}<small>依据更新于 ${recommendation.updatedAt ? new Date(recommendation.updatedAt).toLocaleString("zh-CN") : "等待数据"}</small></div><div class="recommendation-chart" aria-label="关键数据对比"><div><span>点赞</span><i style="--bar:${relativeBar(row.likes, rows, "likes")}%"></i><b>${formatLiveMetric(row.likes)}</b></div><div><span>收藏</span><i style="--bar:${relativeBar(row.collects, rows, "collects")}%"></i><b>${formatLiveMetric(row.collects)}</b></div><div><span>转发</span><i style="--bar:${relativeBar(row.shares, rows, "shares")}%"></i><b>${formatLiveMetric(row.shares)}</b></div><button class="primary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">查看为什么推荐</button><button class="secondary enhance-recommendation" data-note-id="${esc(row.noteId)}" type="button">${insight ? "重新用模型分析" : "用模型增强判断"}</button></div></article>`;
  });
}
function commentFragments(noteId) {
  const envelopes = state.liveDatabase?.rawEnvelopes ?? [];
  const fragments = [];
  for (const envelope of envelopes) {
    if (envelope.noteId !== noteId && envelope.payload?.noteId !== noteId) continue;
    const values = envelope.payload?.observations ?? envelope.payload?.comments ?? envelope.payload?.items ?? envelope.comments ?? [];
    if (Array.isArray(values)) for (const item of values) if (item?.text || item?.rawText) fragments.push({ author: item.author ?? "评论用户", text: item.text ?? item.rawText, reply: item.isReply === true || item.reply === true || item.parentCommentId, replyTo: item.replyTo ?? null, likes: item.likes ?? null });
  }
  return fragments;
}
function commentEvidence(noteId) {
  const envelopes = (state.liveDatabase?.rawEnvelopes ?? []).filter((envelope) => envelope?.kind === "COMMENT_PAGE" && (envelope.noteId === noteId || envelope.payload?.noteId === noteId));
  const latest = [...envelopes].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))[0];
  return latest?.payload?.traversal ?? null;
}
function analysisVerdict(row, note) {
  const comments = commentFragments(row.noteId);
  const commentStats = commentEvidence(row.noteId);
  const saveRatio = row.likes && row.collects !== null ? row.collects / row.likes : null;
  const shareRatio = row.likes && row.shares !== null ? row.shares / row.likes : null;
  const commentCollectionProven = commentStats?.commentFetchSucceeded === true
    && (commentStats.declaredTotal === 0 || Number(commentStats.fetchedTotal) > 0);
  const ready = ["COMPLETE", "ELIGIBLE"].includes(row.evidenceStatus) && commentCollectionProven;
  return {
    decision: ready && comments.length ? "现在做" : ready ? "可参考，暂无高价值评论" : row.comments !== null && row.collects !== null ? "可以先做，详情待补" : "继续观察",
    dimensions: [
      ["抓人机制", note?.title ? `标题用“${note.title.slice(0, 28)}”直接交代主题或结果；封面与开头仍需原页证据。` : "标题、封面或开头证据不足。"],
      ["评论需求", comments.length ? `已保留 ${comments.length} 条高认同或有明确需求的评论/回复，优先回答其中重复出现的问题。` : row.comments !== null ? `平台显示 ${formatNumber(row.comments)} 条评论；系统会继续抓取并过滤低价值内容。` : "评论总量与内容均未采到。"],
      ["收藏价值", saveRatio !== null ? `收藏/点赞约 ${Math.round(saveRatio * 100)}%，适合判断是否具备步骤、清单、避坑或参考价值。` : "收藏或点赞缺失，暂不能判断长期价值。"],
      ["传播动机", shareRatio !== null ? `转发/点赞约 ${Math.round(shareRatio * 100)}%，可验证它是否具备提醒、共鸣或社交谈资。` : "转发数据缺失，传播动机待补。"],
      ["结构可借", note?.body ? `正文已采到 ${note.body.length} 字；可借它的问题顺序和证据排列，不复制原句。` : "正文未完整采到，只能先借选题，不能下结构结论。"],
      ["可做角度", practicalAngle(row, note)],
    ],
  };
}
function productionPlan(row, note) {
  const comments = commentFragments(row.noteId);
  const topic = note?.keywords?.[0] || row.title.replace(/[｜|丨].*$/, "").trim().slice(0, 24);
  const question = comments.find((item) => /[？?]|怎么|如何|哪里|求|能不能|为什么/.test(item.text))?.text;
  return {
    audienceProblem: question ? `优先回答真实评论：“${question.slice(0, 60)}”` : `围绕“${topic}”解决一个具体、可验证的问题；评论问题尚未完整采到。`,
    promise: `让用户看完能完成一次“${topic}”的判断或操作，而不是只获得情绪。`,
    opening: `先展示结果或代价，再用一句话说明这条内容能帮用户解决什么。`,
    middle: ["给出真实场景和前置条件", "拆成 3 个以内的关键步骤并逐步展示", "用对比、过程记录或结果证明有效"],
    ending: question ? `直接补充回答评论里的高频追问，并邀请用户留下自己的具体情况。` : "总结适用边界，并邀请用户留下最想解决的具体问题。",
    materials: ["真实使用或执行场景", "过程画面/截图", "前后对比或结果", comments.length ? "评论区高频问题" : "待采集的评论问题"],
  };
}
function renderAnalysis() {
  const rows = state.liveRanking?.rows ?? [];
  if (!rows.length) {
    el("analysis-cards").innerHTML = `<article class="panel friendly-empty"><strong>还没有可拆解的真实爆款</strong><p>采到榜单后，这里会直接出现具体笔记及可借用的方法，不展示工作流或运行记录。</p><button class="primary" data-go-ranking type="button">去看实时爆款</button></article>`;
  } else {
    el("analysis-cards").innerHTML = rows.slice(0, 6).map((row) => {
      const note = liveNoteFor(row.noteId); const verdict = analysisVerdict(row, note);
      const saveRatio = row.likes && row.collects !== null ? `${Math.round(row.collects / row.likes * 100)}%` : "待补";
      const shareRatio = row.likes && row.shares !== null ? `${Math.round(row.shares / row.likes * 100)}%` : "待补";
      return `<article class="panel analysis-item"><div class="analysis-rank">#${row.rank}</div><div class="analysis-main"><div class="card-top"><div><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><h2>${esc(row.title)}</h2></button><p>${esc(row.author)} · 数据更新时间 ${row.observedAt ? new Date(row.observedAt).toLocaleString("zh-CN") : "待补"}</p></div><span class="badge ${verdict.decision === "现在做" ? "good" : "warn"}">${esc(verdict.decision)}</span></div><div class="analysis-summary"><section><span>证据</span><strong>赞 ${formatLiveMetric(row.likes)} · 藏 ${formatLiveMetric(row.collects)} · 转 ${formatLiveMetric(row.shares)}</strong></section><section><span>爆点机制</span><strong>收藏率 ${saveRatio} · 转发率 ${shareRatio}</strong></section><section><span>可复用动作</span><strong>${esc(practicalAngle(row, note))}</strong></section></div><details class="analysis-details"><summary>展开完整拆解与评论补充证据</summary><div class="method-grid">${verdict.dimensions.map(([label, value]) => `<section><span>${esc(label)}</span><strong>${esc(value)}</strong></section>`).join("")}</div></details><div class="button-row"><button class="secondary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">查看证据</button>${row.sourceUrl ? `<a class="secondary button-link" href="${esc(row.sourceUrl)}" target="_blank" rel="noopener">打开原文</a>` : ""}<button class="primary focus-live-note" data-note-id="${esc(row.noteId)}" type="button">加入我的选题</button></div></div></article>`;
    }).join("");
  }
  document.querySelectorAll("[data-go-ranking]").forEach((button) => button.addEventListener("click", () => switchView("ranking")));
}
function renderDecision() {
  const rows = state.liveRanking?.rows ?? [];
  if (!rows.length) {
    el("decision-cards").innerHTML = `<article class="panel friendly-empty"><strong>还没有可以策划的真实选题</strong><p>实时爆款出现后，先把值得做的内容加入选题库，这里再生成作品结构。</p><button class="primary" data-go-ranking type="button">去看实时爆款</button></article>`;
  } else {
    const ordered = state.autoTopics.length ? state.autoTopics.map((item) => item.row) : rows;
    el("decision-cards").innerHTML = ordered.slice(0, 3).map((row, index) => { const note = liveNoteFor(row.noteId); const plan = productionPlan(row, note); return `<article class="panel decision-item"><div class="decision-source"><span class="badge ${index === 0 ? "good" : "warn"}">优先级 ${index + 1}</span><span>赞 ${formatLiveMetric(row.likes)} · 藏 ${formatLiveMetric(row.collects)} · 转 ${formatLiveMetric(row.shares)}</span></div><div class="decision-priority"><span>建议先做</span><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><h2>${esc(row.title)}</h2></button><p>${esc(practicalAngle(row, note))}</p></div><section class="decision-problem"><span>要解决的具体问题</span><strong>${esc(plan.audienceProblem)}</strong></section><div class="decision-steps"><section><b>1</b><div><strong>开头给结果</strong><p>${esc(plan.opening)}</p></div></section><section><b>2</b><div><strong>中段给方法</strong>${plan.middle.map((item) => `<p>· ${esc(item)}</p>`).join("")}</div></section><section><b>3</b><div><strong>结尾给边界</strong><p>${esc(plan.ending)}</p></div></section></div><details class="decision-details"><summary>查看开工材料与发布检查</summary><div class="production-materials">${plan.materials.map((item) => `<span>✓ ${esc(item)}</span>`).join("")}</div><small>发布前检查：承诺兑现 · 有真实证据 · 不照搬原表达</small></details><div class="decision-footer"><small>账号方向尚未设定：这是平台机会，加入后再确认是否适合你。</small><div class="button-row"><button class="secondary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">查看依据</button><button class="primary focus-live-note" data-note-id="${esc(row.noteId)}" type="button">加入我的选题</button></div></div></article>`; }).join("");
  }
  document.querySelectorAll("[data-go-ranking]").forEach((button) => button.addEventListener("click", () => switchView("ranking")));
}
function topicMatches(topic, filter) {
  const row = topic.row;
  if (filter === "ALL") return true;
  if (filter === "DO_NOW") return topic.readiness === "DO_NOW";
  if (filter === "SHARES") return row.shares !== null && row.shares >= Math.max(...(state.liveRanking?.rows ?? []).map((item) => item.shares ?? 0)) * 0.6;
  if (filter === "SAVES") return row.collects !== null && row.collects >= Math.max(...(state.liveRanking?.rows ?? []).map((item) => item.collects ?? 0)) * 0.6;
  if (filter === "RISING") return ["RISING", "NEW_ENTRY", "REENTERED"].includes(row.trend);
  return true;
}
function renderDatabase() {
  const query = el("database-search").value.trim().toLowerCase();
  const liveNotes = state.liveSearchNotes ?? [];
  const notes = liveNotes.filter((note) => `${note.title} ${note.body ?? ""} ${note.author?.displayName} ${(note.keywords ?? []).join(" ")}`.toLowerCase().includes(query));
  el("database-count").textContent = `${notes.length} 个选题`;
  const health = state.databaseStatus; el("database-health").textContent = health ? `${health.status} · ${state.admittedNoteIds.size} 条已核验 · schema ${health.schemaVersion}` : "数据库待检查"; el("database-health").className = `badge ${health?.status === "OK" ? "good" : "warn"}`;
  el("database-view").innerHTML = `<option value="">选择保存视图</option>${state.databaseViews.map((view) => `<option value="${esc(view.viewId)}">${esc(view.name)}</option>`).join("")}`;
  const suggestions = state.autoTopics.filter((topic) => topicMatches(topic, state.topicFilter));
  el("database-suggestions").innerHTML = suggestions.length ? suggestions.map((topic, index) => { const row = topic.row; const note = liveNoteFor(row.noteId); const preferred = index === 0 && state.topicFilter === "ALL"; return `<article class="panel topic-card ${preferred ? "preferred" : ""}"><div class="topic-card-top"><span class="badge ${preferred ? "good" : "warn"}">${esc(topic.label)}</span><strong class="auto-topic-score">智能分 ${topic.score}</strong></div><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><h3>${esc(row.title)}</h3></button><p>${esc(topic.reason)}。${esc(practicalAngle(row, note))}</p><div class="topic-metrics"><span><b>${formatLiveMetric(row.likes)}</b> 点赞</span><span><b>${formatLiveMetric(row.collects)}</b> 收藏</span><span><b>${formatLiveMetric(row.shares)}</b> 转发</span></div><div class="button-row"><button class="secondary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">看证据</button><button class="primary focus-live-note" data-note-id="${esc(row.noteId)}" type="button">加入选题</button></div></article>`; }).join("") : `<article class="panel friendly-empty"><strong>这个筛选下暂时没有可推荐内容</strong><p>数据更新后会自动出现，不会用示例选题填充。</p></article>`;
  el("database-rows").innerHTML = notes.length ? notes.map((note) => { const row = state.liveRanking?.rows?.find((item) => item.noteId === note.noteId); const sourceUrl = note.provenance?.sourceUrls?.[0]; return `<tr><td class="note-cell"><button class="title-link open-note-detail" data-note-id="${esc(note.noteId)}" type="button"><strong>${esc(note.title)}</strong></button><small>${esc(note.author?.displayName || "作者未采到")}</small></td><td>赞 ${formatNumber(note.metrics?.likes)} · 藏 ${formatNumber(note.metrics?.collects)} · 转 ${formatNumber(note.metrics?.shares)}</td><td>${esc(row?.noteId === state.autoTopics[0]?.row.noteId ? "当前智能首选" : row?.reason ?? "已手动加入，等待进一步拆解")}</td><td><div class="row-actions"><button class="secondary open-note-detail" data-note-id="${esc(note.noteId)}" type="button">看详情</button>${sourceUrl ? `<a class="secondary button-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener">原文</a>` : ""}<button class="secondary edit-note-tags" data-note-id="${esc(note.noteId)}" type="button">整理标签</button></div></td></tr>`; }).join("") : `<tr><td colspan="4" class="loading-cell">你还没手动加入选题；上方已经给出系统推荐，可以直接查看并加入。</td></tr>`;
  document.querySelectorAll(".edit-note-tags").forEach((button) => button.addEventListener("click", () => editNoteTags(button.dataset.noteId)));
}
async function refreshDatabaseQuery() {
  const parameters = new URLSearchParams({ q: el("database-search").value.trim(), limit: "500" });
  const tag = el("database-tag-filter").value.trim(); if (tag) parameters.set("tag", tag);
  try { const result = await api(`/api/database/notes?${parameters}`); state.liveSearchNotes = result.notes.filter((note) => state.admittedNoteIds.has(note.noteId)); renderDatabase(); }
  catch (error) { toast(`数据库检索失败：${error.message}`, "error"); }
}
async function editNoteTags(noteId) {
  const entered = window.prompt("输入标签，多个标签用逗号分隔；留空表示清除标签。"); if (entered === null) return;
  try { const result = await api(`/api/database/notes/${encodeURIComponent(noteId)}/tags`, { method: "PUT", body: JSON.stringify({ tags: entered.split(/[，,]/).map((value) => value.trim()).filter(Boolean) }) }); el("database-tag-filter").value = result.tags[0] ?? ""; await refreshDatabaseQuery(); toast("标签已保存", "success"); }
  catch (error) { toast(`标签保存失败：${error.message}`, "error"); }
}
async function restoreDatabase() {
  const file = el("database-restore-file").files?.[0];
  if (!file) return toast("请先选择 SQLite 备份文件", "error");
  if (!window.confirm(`恢复会替换当前真实证据库。系统将先校验 ${file.name} 并自动备份当前库，确定继续吗？`)) return;
  const status = el("database-restore-status"); status.textContent = "正在上传、验真、备份和换库，请勿关闭页面…";
  try {
    const response = await fetch("/api/database/restore?confirm=true", { method: "POST", headers: { "content-type": "application/vnd.sqlite3" }, body: await file.arrayBuffer() });
    const receipt = await response.json().catch(() => ({})); if (!response.ok) throw new Error(receipt.error ?? `HTTP_${response.status}`);
    status.textContent = `恢复成功：${receipt.integrity.noteCount} 条笔记；恢复前备份 ${receipt.backupPath ?? "无旧库"}；回执 ${receipt.receiptPath}`;
    el("database-restore-file").value = ""; await loadCore(); toast("SQLite 已验证并安全恢复", "success");
  } catch (error) { status.textContent = `恢复失败：${error.message}。当前库未被未验证文件覆盖。`; toast(`恢复失败：${error.message}`, "error"); }
}
function formatLiveMetric(value) { return value === null || value === undefined ? "未采到" : formatNumber(value); }
function sectorFor(row, note) {
  const text = `${row.title} ${(note?.keywords ?? []).join(" ")}`;
  const sectors = [["美食", /美食|做饭|菜谱|烘焙|咖啡|餐厅/], ["穿搭", /穿搭|服装|鞋|包|显瘦/], ["护肤美妆", /护肤|美妆|口红|粉底|面膜/], ["家居", /家居|装修|收纳|房间|好物/], ["职场学习", /职场|学习|考研|工作|效率/], ["旅行", /旅行|旅游|酒店|攻略|城市/], ["数码", /数码|手机|电脑|相机|AI|软件/], ["健身", /健身|减脂|运动|瑜伽/], ["母婴", /母婴|宝宝|育儿|孕/]];
  return sectors.find(([, pattern]) => pattern.test(text))?.[0] ?? "生活方式";
}
function renderTodayOverview() {
  const rows = state.liveRanking?.rows ?? [];
  if (!rows.length) {
    el("today-headline").textContent = "还没有采到今天的真实榜单";
    el("today-guidance").textContent = "采集连接后，这里会自动告诉你各领域正在发生什么。";
    el("today-actions").innerHTML = "";
    el("sector-grid").innerHTML = `<article class="panel friendly-empty"><strong>等待今天的第一批爆款</strong><p>这里不会用示例数据冒充实时趋势。</p></article>`;
    return;
  }
  const strongestTopic = state.autoTopics[0];
  const strongest = strongestTopic?.row ?? state.recommendation?.topPick ?? rows[0];
  el("today-headline").textContent = `先验证：${strongest.title}`;
  el("today-guidance").textContent = `${strongestTopic?.reason ?? state.recommendation?.guidance ?? strongest.reason} · ${state.projectState?.direction === "UNSET" ? "这是平台机会，账号方向未设定" : "已结合账号方向"}`;
  const collected = [...rows].filter((row) => row.noteId !== strongest.noteId).sort((a, b) => (b.collects ?? -1) - (a.collects ?? -1))[0];
  const shared = [...rows].filter((row) => row.noteId !== strongest.noteId && row.noteId !== collected?.noteId).sort((a, b) => (b.shares ?? -1) - (a.shares ?? -1))[0];
  el("today-actions").innerHTML = `<article class="panel today-focus-card"><div><span class="badge good">${esc(strongestTopic?.label ?? "今日首选")}</span><h3>${esc(strongest.title)}</h3><p>${esc(practicalAngle(strongest, liveNoteFor(strongest.noteId)))}</p></div><div class="today-focus-metrics"><span><b>${formatLiveMetric(strongest.likes)}</b>点赞</span><span><b>${formatLiveMetric(strongest.collects)}</b>收藏</span><span><b>${formatLiveMetric(strongest.shares)}</b>转发</span></div><button class="primary open-note-detail" data-note-id="${esc(strongest.noteId)}" type="button">查看证据并决定</button></article><div class="today-support-list">${[["收藏信号", collected], ["转发信号", shared]].filter(([, row]) => row).map(([label, row]) => `<button class="today-action open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><span>${label}</span><strong>${esc(row.title)}</strong><small>赞 ${formatLiveMetric(row.likes)} · 藏 ${formatLiveMetric(row.collects)} · 转 ${formatLiveMetric(row.shares)}</small></button>`).join("")}</div>`;
  const groups = new Map(); rows.forEach((row) => { const sector = sectorFor(row, liveNoteFor(row.noteId)); groups.set(sector, [...(groups.get(sector) ?? []), row]); });
  el("sector-grid").innerHTML = [...groups.entries()].slice(0, 4).map(([sector, items]) => { const top = items[0]; return `<article class="panel sector-card"><div class="sector-title"><h3>${esc(sector)}</h3><span>${items.length} 条候选</span></div><button class="title-link open-note-detail" data-note-id="${esc(top.noteId)}" type="button"><strong class="sector-leading">${esc(top.title)}</strong></button><div class="sector-numbers"><span><b>${formatLiveMetric(top.likes)}</b> 点赞</span><span><b>${formatLiveMetric(top.collects)}</b> 收藏</span><span><b>${formatLiveMetric(top.shares)}</b> 转发</span></div><p>${esc(practicalAngle(top, liveNoteFor(top.noteId)))}</p><button class="secondary open-note-detail" data-note-id="${esc(top.noteId)}" type="button">看这个领域怎么做</button></article>`; }).join("");
}
function coverImage(row) {
  try {
    const url = new URL(row.coverUrl);
    if (["http:", "https:"].includes(url.protocol)) return `<img class="post-cover" src="${esc(url.href)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  } catch { /* Keep the cover column even when no image was collected. */ }
  return `<span class="post-cover post-cover-missing" aria-hidden="true"></span>`;
}
function renderRanking() {
  const ranking = state.liveRanking ?? buildLiveRanking(state.liveDatabase);
  const cutoff = Date.now() - state.marketHours * 60 * 60 * 1000;
  const candidates = ranking.rows.filter((row) => Math.max(Date.parse(row.lastSeenAt ?? "") || 0, Date.parse(row.observedAt ?? "") || 0) >= cutoff);
  const rows = candidates.filter(hasThreeMetrics).map((row, index) => ({ ...row, rank: index + 1 }));
  const pending = candidates.length - rows.length;
  const pendingHost = el("live-ranking-pending");
  const pendingMarkup = pendingCandidates(candidates, { open: pendingHost.querySelector("details")?.open ?? false, limit: state.pendingLimit ?? 10 });
  if (pendingHost.innerHTML !== pendingMarkup) pendingHost.innerHTML = pendingMarkup;
  const collector = state.runtime?.realCollector;
  const running = state.realRefreshActive || collector?.status === "RUNNING";
  el("live-ranking-status").textContent = running ? "正在更新" : collector?.status === "FAILED" ? "更新失败 · 保留已有数据" : pending ? "部分数据待补" : rows.length ? "已同步" : "暂无窗口内数据";
  el("live-ranking-status").className = `badge ${collector?.status === "FAILED" ? "block" : rows.length && !running && !pending ? "good" : "warn"}`;
  el("live-ranking-caption").textContent = running ? "正在已打开的小红书标签页内收集搜索卡片；不逐条打开视频或详情。" : rows.length && ranking.observedAt ? `最近同步 ${new Date(ranking.observedAt).toLocaleString("zh-CN")} · 同步只读取已有数据，更新会发起新检查` : "等待真实采集数据；也可点击“更新”发起检查";
  const coverage = rankingCoverage(candidates);
  el("live-ranking-summary").textContent = `当前时间窗：${coverage.total} 条候选 · 三项齐全 ${coverage.complete} 条 · 完整率 ${coverage.completePercent === null ? "暂无样本" : `${coverage.completePercent}%`}${pending ? `；缺点赞 ${coverage.missing.likes} 条、缺收藏 ${coverage.missing.collects} 条、缺转发 ${coverage.missing.shares} 条（可重叠）` : ""}。缺失不作 0，待补候选独立保留。`;
  el("ranking-more").hidden = rows.length <= 10;
  el("ranking-more").textContent = state.rankingExpanded ? "收起" : `查看更多（还有 ${rows.length - 10} 条）`;
  el("live-ranking-rows").innerHTML = rows.length ? rows.slice(0, state.rankingExpanded ? undefined : 10).map((row) => `<tr class="clickable-row" data-open-note-id="${esc(row.noteId)}"><td class="rank ${row.rank <= 3 ? "rank-top" : ""}">${row.rank}</td><td class="note-cell"><div class="post-title-line">${coverImage(row)}<span><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><strong>${esc(row.title)}</strong></button><small>${esc(row.author)}${row.mediaType === "VIDEO" ? " · 视频 · 搜索级入台" : row.evidenceStatus === "ELIGIBLE" ? " · 已补详情" : " · 搜索候选"}</small></span></div></td><td class="ranking-reason">${rankingEvidence(row)}</td><td class="metric-cell"><b>${formatLiveMetric(row.likes)}</b>${metricDeltaLabel(row, "likes")}</td><td class="metric-cell"><b>${formatLiveMetric(row.collects)}</b>${metricDeltaLabel(row, "collects")}</td><td class="metric-cell"><b>${formatLiveMetric(row.shares)}</b>${metricDeltaLabel(row, "shares")}</td><td><div class="row-actions"><button class="secondary copy-note-url" data-note-id="${esc(row.noteId)}" type="button" ${row.sourceUrl ? "" : "disabled"}>复制地址</button>${row.sourceUrl ? `<a class="secondary button-link" href="${esc(row.sourceUrl)}" target="_blank" rel="noopener">原文</a>` : ""}</div></td></tr>`).join("") : `<tr><td colspan="7" class="loading-cell">${pending ? `${pending} 条候选还缺点赞、收藏或转发；补齐后才会上榜。` : "尚未采到真实榜单；系统连接后会自动出现。"}</td></tr>`;
}
function marketTrend(topic) {
  const symbol = topic.trend === "UP" ? "↑" : topic.trend === "DOWN" ? "↓" : "●";
  const label = topic.trend === "UP" ? "上升" : topic.trend === "DOWN" ? "下降" : "待观察";
  return `<span class="market-trend ${topic.trend === "UP" ? "up" : topic.trend === "DOWN" ? "down" : "flat"}">${symbol} ${label}${topic.growth > 0 ? ` · +${formatNumber(topic.growth)}` : ""}</span>`;
}
function marketTopicHeader(board) {
  return `<div class="market-topic-header" role="row" aria-label="${board === "direction" ? "方向" : "全站"}选题榜列标题"><span>排名</span><span>选题方向</span><span>热度</span><span>变化</span><span>最近更新</span><span>查看</span></div>`;
}
function marketPostHeader() {
  return `<div class="market-post-header" role="row" aria-label="帖子榜列标题"><span>排名</span><span>封面</span><span>帖子标题</span><span>状态与变化</span><span class="market-post-metrics-header"><span>点赞</span><span>收藏</span><span>转发</span></span><span>操作</span></div>`;
}
function compactMarketTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function marketTopicRows(topics, board) {
  return topics.map((topic, index) => `<button class="market-topic-row open-market-topic ${index < 3 ? "top-three" : ""}" data-board="${board}" data-topic="${esc(topic.label)}" type="button"><b class="market-rank ${index < 3 ? "top" : ""}">${index + 1}</b><span class="market-topic-main"><strong>${esc(topic.label)}</strong><small>${topic.count} 条帖子 · 收藏/转发完整 ${topic.coverage} 条</small></span><span class="market-topic-score">${formatNumber(topic.score)}</span>${marketTrend(topic)}<span class="market-topic-updated">${topic.lastUpdatedAt ? `<time datetime="${esc(topic.lastUpdatedAt)}" title="最近一次帖子在榜或数据观测，不代表互动数变化">${compactMarketTime(topic.lastUpdatedAt)}</time>` : "暂无记录"}</span><span class="market-chevron">→</span></button>`).join("");
}
function renderMarket() {
  const market = state.marketState ?? { direction: "", preciseTerms: [], archives: [], favorites: [] };
  const topics = buildMarketTopics(state.liveRanking?.rows ?? [], { windowHours: state.marketHours, direction: market.direction, preciseTerms: market.preciseTerms });
  state.marketTopics = topics;
  renderComparison(state, document);
  const latestSearch = [...(state.runtime?.keywordRuns ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const latestSearchCopy = latestSearch ? ` · 最近采集 ${formatNumber(latestSearch.counters?.admittedCards ?? latestSearch.counters?.ingestedCandidates ?? 0)} 条候选、${formatNumber(latestSearch.counters?.savedNotes ?? 0)} 条完整资料；重复帖子去重，互动未变时榜单不变` : "";
  el("market-all-summary").textContent = `近 ${state.marketHours === 24 ? "24 小时" : `${state.marketHours / 24} 天`} · ${topics.sampleCount} 条已观测帖子 · ${topics.all.length} 个选题方向${latestSearchCopy}`;
  el("market-all-topics").innerHTML = topics.all.length ? marketTopicHeader("all") + marketTopicRows(topics.all.slice(0, state.marketExpanded.all ? undefined : 10), "all") : `<div class="friendly-empty"><strong>这个时间窗暂无真实数据</strong><p>可切换到 3 天或 7 天，或开启新一轮采集。</p></div>`;
  el("market-all-more").hidden = topics.all.length <= 10;
  el("market-all-more").textContent = state.marketExpanded.all ? "收起" : `查看更多（${topics.all.length - 10} 个方向）`;
  if (!state.marketDraftDirty) {
    el("market-direction").value = market.direction ?? "";
    el("market-terms").value = (market.preciseTerms ?? []).join("，");
  }
  el("market-direction-summary").textContent = market.direction ? `当前方向：${market.direction} · ${topics.direction.length} 个已采到的选题` : "尚未设定方向；输入一段描述，可随时修改";
  el("market-direction-topics").innerHTML = !market.direction ? `<div class="friendly-empty"><strong>先输入你要研究的方向</strong><p>保存后点击“更新”，会同时检查我的方向和全站。</p></div>` : topics.direction.length ? marketTopicHeader("direction") + marketTopicRows(topics.direction, "direction") : `<div class="friendly-empty"><strong>这个方向暂未匹配到近 ${state.marketHours / 24} 天的数据</strong><p>点击“更新”会同时发起方向采集和全站检查；新数据入台后才会改变榜单。</p></div>`;
  el("market-direction-more").hidden = topics.direction.length <= 10;
  el("market-direction-more").textContent = state.marketExpanded.direction ? "收起" : `查看更多（${topics.direction.length - 10} 个方向）`;
  el("market-archives").innerHTML = (market.archives ?? []).length ? `<details><summary>已归档的旧方向（${market.archives.length}）</summary>${market.archives.map((item, index) => `<div class="archive-row"><span>${esc(item.direction)} · ${new Date(item.archivedAt).toLocaleDateString("zh-CN")}</span><button class="secondary delete-market-archive" data-index="${index}" type="button">删除归档</button></div>`).join("")}</details>` : "";
  renderMarketDrill();
}
function renderMarketDrill() {
  const selection = state.marketDrill;
  const topic = selection && (state.marketTopics?.[selection.board] ?? []).find((item) => item.label === selection.label);
  el("market-drill").hidden = !topic;
  if (!topic) return;
  el(`market-${selection.board === "direction" ? "direction" : "all"}-topics`).closest(".market-board").after(el("market-drill"));
  el("market-drill-title").textContent = `${topic.label} · 帖子榜`;
  el("market-drill-close").textContent = state.marketDrillCollapsed ? "展开" : "收起";
  el("market-drill-close").setAttribute("aria-expanded", String(!state.marketDrillCollapsed));
  el("market-drill-rows").hidden = state.marketDrillCollapsed;
  const verifiedRows = topic.rows.filter(hasThreeMetrics);
  const missingCount = topic.rows.length - verifiedRows.length;
  el("market-drill-more").hidden = state.marketDrillCollapsed || verifiedRows.length <= 10;
  if (state.marketDrillCollapsed) return;
  const rows = verifiedRows.slice(0, state.marketDrillExpanded ? undefined : 10);
  el("market-drill-rows").innerHTML = `<p class="metric-coverage">三项互动齐全 ${verifiedRows.length} 条${missingCount ? ` · ${missingCount} 条待补采，不参与帖子榜排序` : ""}</p>` + (rows.length ? marketPostHeader() + rows.map((row, index) => `<div class="market-post-row ${index < 3 ? "top-three" : ""}"><b class="market-rank ${index < 3 ? "top" : ""}">${index + 1}</b>${coverImage(row)}<div class="market-post-main"><button class="title-link open-note-detail" data-note-id="${esc(row.noteId)}" type="button"><strong>${esc(row.title)}</strong></button><small>${esc(row.author)} · ${esc(row.sourceScope ?? "搜索样本")}</small></div><span class="market-trend ${(row.recentGrowth > 0 || row.trend === "RISING") ? "up" : row.trend === "FALLING" ? "down" : "flat"}">${row.recentGrowth > 0 ? `↑ +${formatNumber(row.recentGrowth)}` : row.trend === "FALLING" ? "↓ 下降" : "● 待观察"}</span><span class="market-post-metrics"><span>${formatLiveMetric(row.likes)}</span><span>${formatLiveMetric(row.collects)}</span><span>${formatLiveMetric(row.shares)}</span></span><div class="market-post-actions"><button class="secondary copy-note-url" data-note-id="${esc(row.noteId)}" type="button">复制地址</button><button class="secondary focus-live-note" data-note-id="${esc(row.noteId)}" type="button">收藏</button></div></div>`).join("") : `<div class="friendly-empty"><strong>暂无线索满足三项互动齐全</strong><p>搜索候选仍保留在采集台；点赞、收藏、转发补齐后自动进入此榜。</p></div>`);
  el("market-drill-more").textContent = state.marketDrillExpanded ? "收起" : `查看更多帖子（${verifiedRows.length - 10}）`;
}
function renderFavorites() {
  const favorites = state.marketState?.favorites ?? [];
  el("favorite-count").textContent = `${favorites.length} 条`;
  const groups = new Map();
  for (const item of favorites) groups.set(item.direction || "全站", [...(groups.get(item.direction || "全站") ?? []), item]);
  el("favorite-list").innerHTML = favorites.length ? [...groups].map(([direction, items]) => `<section class="favorite-group"><h3>${esc(direction)} <small>${items.length} 条</small></h3>${items.map((item) => `<label class="favorite-row"><input type="checkbox" class="favorite-check" value="${esc(item.noteId)}" /><span><strong>${esc(item.title)}</strong><small>收藏于 ${new Date(item.savedAt).toLocaleString("zh-CN")}</small></span><button class="secondary copy-note-url" data-note-id="${esc(item.noteId)}" type="button">复制地址</button></label>`).join("")}</section>`).join("") : `<div class="friendly-empty"><strong>还没有收藏</strong><p>在帖子榜或详情中，手动收藏你要保留的具体帖子。</p></div>`;
}
async function openNoteDetail(noteId) {
  const row = state.liveRanking?.rows?.find((item) => item.noteId === noteId);
  const note = liveNoteFor(noteId) ?? state.liveSearchNotes?.find((item) => item.noteId === noteId);
  if (!row && !note) return toast("这条内容当前不在本地数据中", "error");
  const sourceView = state.view === "detail" ? "history" : state.view;
  const allowedParents = new Set(["overview", "ranking", "database", "analysis", "decision", "history"]);
  if (state.view !== "detail" && allowedParents.has(state.view)) state.detailParentView = state.view;
  state.selectedId = noteId;
  await api("/api/view-history", { method: "POST", body: JSON.stringify({ noteId, title: row?.title ?? note?.title, author: row?.author ?? note?.author?.displayName, sector: sectorFor(row ?? { title: note?.title ?? "" }, note), sourceView, sourceUrl: row?.sourceUrl ?? note?.provenance?.sourceUrls?.[0] ?? null, selected: (state.liveSearchNotes ?? []).some((item) => item.noteId === noteId) }) }).catch(() => {});
  renderDetail();
  switchView("detail");
}
function detailAssets(note) {
  return (Array.isArray(note?.assets) ? note.assets : []).filter((asset) => {
    try { return ["http:", "https:"].includes(new URL(String(asset?.sourceUrl ?? "")).protocol); } catch { return false; }
  });
}
function renderDetailAssets(note) {
  const assets = detailAssets(note);
  const expected = Number.isInteger(note?.expectedAssetCount) ? note.expectedAssetCount : null;
  const countCopy = expected === null ? `已采到 ${assets.length} 项` : `应有 ${expected} 项 · 已采到 ${assets.length} 项`;
  const cards = assets.map((asset, index) => {
    const label = asset.type === "VIDEO" ? "视频" : asset.type === "VIDEO_COVER" ? "视频封面" : "图片";
    const ordinal = Number.isInteger(asset.ordinal) ? asset.ordinal : index + 1;
    const url = esc(asset.sourceUrl);
    if (asset.type === "VIDEO") return `<a class="detail-asset-card detail-asset-video" href="${url}" target="_blank" rel="noopener"><span class="detail-asset-play">▶</span><strong>打开第 ${ordinal} 个视频</strong><small>保留原始素材地址，仅用于研究参考</small></a>`;
    return `<a class="detail-asset-card" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${label} ${ordinal}" loading="lazy" referrerpolicy="no-referrer" /><span><strong>${label} ${ordinal}</strong><small>点击查看原素材</small></span></a>`;
  }).join("");
  return `<section class="detail-assets"><div class="section-intro"><div><h3>作品素材</h3><p>素材只在已有详情证据时展示；视频候选默认不播放、不遍历、不下载。</p></div><strong>${esc(countCopy)}</strong></div>${cards ? `<div class="detail-asset-grid">${cards}</div>` : `<div class="friendly-empty"><strong>当前是搜索级候选</strong><p>候选已经进入采集台；素材与正文按需补证，不阻塞爆款初筛。</p></div>`}</section>`;
}
function renderDetail() {
  const noteId = state.selectedId; const row = state.liveRanking?.rows?.find((item) => item.noteId === noteId); const note = liveNoteFor(noteId) ?? state.liveSearchNotes?.find((item) => item.noteId === noteId);
  if (!noteId || (!row && !note)) { el("detail-content").innerHTML = `<div class="friendly-empty"><strong>尚未选择内容</strong><p>从爆款、选题、拆解或历史记录中点进来查看。</p></div>`; return; }
  const verdict = analysisVerdict(row ?? { noteId, rank: "?", title: note.title, author: note.author?.displayName ?? "作者未采到", likes: note.metrics?.likes ?? null, collects: note.metrics?.collects ?? null, comments: note.metrics?.comments ?? null, shares: note.metrics?.shares ?? null, evidenceStatus: "DETAIL_ONLY", reason: "详情证据" }, note);
  const sourceUrl = row?.sourceUrl ?? note?.provenance?.sourceUrls?.[0];
  const metricHistory = row?.metricHistory ?? [];
  const changeRows = metricHistory.slice(-8).reverse().map((item) => `<tr><td>${new Date(item.observedAt).toLocaleString("zh-CN")}</td><td>${formatLiveMetric(item.likes)}</td><td>${formatLiveMetric(item.collects)}</td><td>${formatLiveMetric(item.shares)}</td><td>${esc(item.sourceKind ?? "采集快照")}</td></tr>`).join("");
  const changes = `<section class="detail-changes"><div class="section-intro"><div><h3>同一帖子的数据变化</h3><p>按采集时间保留历史快照；涨幅来自同一指标最近两次有效记录。</p></div><strong>数据变化：赞 ${metricDeltaLabel(row ?? {}, "likes")} · 藏 ${metricDeltaLabel(row ?? {}, "collects")} · 转 ${metricDeltaLabel(row ?? {}, "shares")}</strong></div>${changeRows ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>点赞</th><th>收藏</th><th>转发</th><th>证据</th></tr></thead><tbody>${changeRows}</tbody></table></div>` : `<div class="friendly-empty"><strong>等待第二次采集</strong><p>同一帖子再次出现后，这里会呈现数据变化。</p></div>`}</section>`;
  el("detail-content").innerHTML = `<div class="detail-head"><div><span class="badge ${verdict.decision === "现在做" ? "good" : "warn"}">${esc(verdict.decision)}</span><h2>${esc(row?.title ?? note?.title)}</h2><p>${esc(row?.author ?? note?.author?.displayName ?? "作者未采到")} · 最近数据 ${row?.observedAt ?? note?.metrics?.observedAt ? new Date(row?.observedAt ?? note.metrics.observedAt).toLocaleString("zh-CN") : "未采到"}</p></div><div class="button-row">${sourceUrl ? `<button class="secondary copy-note-url" data-note-id="${esc(noteId)}" type="button">复制地址</button><button class="secondary enrich-note" data-note-id="${esc(noteId)}" type="button">打开详情补数据</button><a class="secondary button-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener">打开原文</a>` : ""}<button class="primary focus-live-note" data-note-id="${esc(noteId)}" type="button">收藏这条帖子</button></div></div><div class="detail-metrics"><section><b>${formatLiveMetric(row?.likes ?? note?.metrics?.likes)}</b><span>点赞 ${metricDeltaLabel(row ?? {}, "likes")}</span></section><section><b>${formatLiveMetric(row?.collects ?? note?.metrics?.collects)}</b><span>收藏 ${metricDeltaLabel(row ?? {}, "collects")}</span></section><section><b>${formatLiveMetric(row?.shares ?? note?.metrics?.shares)}</b><span>转发 ${metricDeltaLabel(row ?? {}, "shares")}</span></section></div>${changes}`;
  renderMetricTimeline(state, document);
}
async function loadViewHistory() {
  const params = new URLSearchParams();
  if (el("history-search").value.trim()) params.set("q", el("history-search").value.trim());
  if (el("history-source").value) params.set("sourceView", el("history-source").value);
  if (el("history-selected").value) params.set("selected", el("history-selected").value);
  const result = await api(`/api/view-history?${params}`); state.viewHistory = result.entries; renderViewHistory();
}
function renderViewHistory() {
  el("history-count").textContent = `${state.viewHistory.length} 条记录`;
  el("history-list").innerHTML = state.viewHistory.length ? state.viewHistory.map((item) => `<article class="history-item"><div><span>${esc(item.sector || "未分类")} · 看过 ${item.viewCount} 次</span><button class="title-link open-note-detail" data-note-id="${esc(item.noteId)}" type="button"><h3>${esc(item.title)}</h3></button><p>${esc(item.author || "作者未采到")} · 最近查看 ${new Date(item.lastViewedAt).toLocaleString("zh-CN")}</p></div><div class="button-row"><span class="badge ${item.selected ? "good" : "warn"}">${item.selected ? "已加入选题" : "未加入选题"}</span><button class="secondary open-note-detail" data-note-id="${esc(item.noteId)}" type="button">再次查看</button><button class="danger delete-history" data-note-id="${esc(item.noteId)}" type="button">删除</button></div></article>`).join("") : `<div class="friendly-empty"><strong>没有符合筛选条件的记录</strong><p>从任一爆款标题进入详情后，会自动留在这里。</p></div>`;
}
async function deleteViewHistory(noteId) {
  if (!window.confirm("删除这条浏览记录？此操作不会删除采集数据或选题。")) return;
  await api(`/api/view-history/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  await loadViewHistory();
  toast("浏览记录已删除", "success");
}
async function clearViewHistory() {
  if (!state.viewHistory.length) return toast("浏览历史已经是空的", "info");
  if (!window.confirm("一键清空全部浏览历史？采集数据和选题不会受影响。")) return;
  await api("/api/view-history", { method: "DELETE" });
  await loadViewHistory();
  toast("浏览历史已清空", "success");
}
function readPlanHistory() { try { return JSON.parse(localStorage.getItem(planHistoryKey) ?? "[]"); } catch { return []; } }
function saveDraft() {
  localStorage.setItem(draftKey, JSON.stringify({ seeds: el("seed-keywords").value, target: el("collection-target").value, maxDepth: el("max-depth").value, maxKeywords: el("max-keywords").value, notesPerKeyword: el("notes-per-keyword").value, commentLimit: el("collection-comment-limit").value, requestInterval: el("request-interval").value, slowNetworkMinutes: el("slow-network-minutes").value, searchScope: el("search-scope").value, collectionMethod: el("collection-method").value, autoCollectNotes: false }));
}
function restoreDraft() {
  try { const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null"); if (!draft) return; el("seed-keywords").value = draft.seeds ?? ""; el("collection-target").value = draft.target ?? 100; el("max-depth").value = draft.maxDepth ?? 1; el("max-keywords").value = draft.maxKeywords ?? 300; el("notes-per-keyword").value = draft.notesPerKeyword ?? 5; el("collection-comment-limit").value = draft.commentLimit ?? 50; el("request-interval").value = draft.requestInterval ?? 1500; el("slow-network-minutes").value = draft.slowNetworkMinutes ?? 5; el("search-scope").value = draft.searchScope ?? "ALL_EXPANDED"; el("collection-method").value = draft.collectionMethod ?? "TOP_N"; el("auto-collect-notes").checked = false; } catch {}
}
function renderPlanHistory() {
  const history = readPlanHistory();
  el("plan-history").innerHTML = history.length ? `<option value="">选择一条历史任务</option>${history.map((item, index) => `<option value="${index}">${esc(new Date(item.createdAt).toLocaleString("zh-CN"))} · ${item.seeds.length} 个种子词</option>`).join("")}` : `<option value="">暂无历史任务</option>`;
}
function renderCollection() {
  renderResearchWorkspace();
  const keywordRuns = state.runtime?.keywordRuns ?? [];
  const rankingRuns = state.runtime?.rankingRuns ?? [];
  const legacyRuns = state.runtime?.researchRuns ?? [];
  const runs = [...keywordRuns, ...rankingRuns].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const activeStatuses = ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"];
  const progress = state.runtime?.collectionProgress;
  const job = progress?.run ?? runs.find((run) => activeStatuses.includes(run.status)) ?? runs[0] ?? legacyRuns[0] ?? null;
  const labels = { QUEUED: "准备中", RUNNING: "采集中", PAUSED: "已暂停", CANCEL_REQUESTED: "正在停止", CANCELLED: "已停止", SUCCEEDED: "已完成", PARTIAL: "部分完成", FAILED: "未完成" };
  const counters = job?.counters ?? {};
  const metricEntries = Object.values(job?.metricGaps ?? {});
  const metricsComplete = metricEntries.filter(gaps => gaps.length === 0).length;
  const metricsPending = metricEntries.filter(gaps => gaps.length > 0).length;
  const metricsCopy = job?.settings?.completeMetrics ? `三项指标齐全 ${metricsComplete} 条 · 缺指标 ${metricsPending} 条` : `详情已入库 ${formatNumber(counters.savedNotes ?? 0)} 条`;
  const browserTasks = state.runtime?.browserTasks ?? [];
  renderCompleteness(job, browserTasks, document);
  const keywordTaskRows = job?.keywords?.map((keyword) => {
    const tasks = browserTasks.filter((task) => task.context?.runId === job.runId && task.context?.keywordId === keyword.keywordId);
    const terminal = tasks.length && tasks.every((task) => ["SUCCEEDED", "SKIPPED", "BLOCKED", "FAILED", "CANCELLED"].includes(task.status));
    const failed = tasks.some((task) => ["BLOCKED", "FAILED"].includes(task.status));
    return { ...keyword, status: terminal ? (failed ? "FAILED" : "SUCCEEDED") : tasks.some((task) => task.status === "LEASED") ? "RUNNING" : "QUEUED", savedNotes: tasks.filter((task) => task.expectedPageType === "NOTE_DETAIL" && task.status === "SUCCEEDED").length, retainedComments: 0 };
  }) ?? [];
  const queue = job?.queue ?? keywordTaskRows;
  const current = queue.find((item) => item.keywordId === job?.currentKeywordId) ?? queue.find((item) => item.status === "RUNNING");
  const completed = Number(progress?.completed ?? counters.completedKeywords ?? queue.filter((item) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.status)).length);
  const total = Math.max(0, Number(progress?.total ?? counters.totalKeywords ?? job?.keywords?.length ?? queue.length));
  const currentFraction = current?.progress?.total ? Math.min(1, current.progress.completed / current.progress.total) : 0;
  const savedCount = job ? Number(progress?.admitted ?? counters.admittedCards ?? counters.ingestedCandidates ?? 0) : 0;
  const targetCount = Number(progress?.target ?? job?.settings?.searchLimit ?? 0);
  const percent = progress?.percent ?? (targetCount ? Math.min(100, Math.round(savedCount / targetCount * 100)) : total ? Math.min(100, Math.round((completed + currentFraction) / total * 100)) : 0);
  const liveCard = el("collection-live-card");
  const active = activeStatuses.includes(job?.status);
  liveCard.hidden = false;
  el("collection-card-expand").hidden = true;
  el("collection-card-expand").setAttribute("aria-expanded", String(Boolean(job && state.collectionCardExpanded)));
  el("collection-inline-expand").disabled = false;
  if (job) liveCard.dataset.runId = job.runId;
  const shortfall = job?.status === "SUCCEEDED" && targetCount > 0 && savedCount < targetCount;
  el("collection-status").textContent = job ? shortfall ? "已结束·未达目标" : labels[job.status] ?? job.status : "待开始";
  el("collection-status").className = `badge ${job?.status === "SUCCEEDED" && !shortfall ? "good" : ["FAILED", "CANCELLED"].includes(job?.status) ? "block" : "warn"}`;
  el("collection-inline-admitted").textContent = formatNumber(savedCount);
  el("collection-inline-saved").textContent = formatNumber(counters.savedNotes ?? 0);
  el("collection-inline-summary").textContent = !job ? "开始后，候选帖子会直接进入榜单。" : active ? `${labels[job.status]}：${savedCount}/${targetCount} 条搜索候选` : shortfall ? `本轮搜索结束，已找到 ${savedCount}/${targetCount} 条；候选不足。` : `本轮${labels[job.status] ?? job.status}，已找到 ${savedCount} 条搜索候选。`;
  el("collection-phase").textContent = job?.phase ?? (job ? "浏览器扩展任务队列" : "等待开始");
  el("collection-stage").textContent = progress?.runKind === "RANKING" ? "榜单更新" : job?.phase ?? (job ? "关键词采集" : "等待开始");
  const terminalKeywordCopy = { SUCCEEDED: "全部完成", PARTIAL: "候选已入台，部分补证未完成", FAILED: "本轮采集未完成", CANCELLED: "本轮已停止" };
  const progressCopy = job?.status === "FAILED"
    ? `已检查 ${completed}/${total} 个关键词 · 已发现候选仍保留在采集台`
    : job?.status === "PARTIAL"
      ? `候选 ${savedCount}/${targetCount} 条 · ${metricsCopy} · 未达目标或补采存在缺口`
      : job?.status === "CANCELLED"
        ? `已检查 ${completed}/${total} 个关键词 · 已安全停止`
        : job?.status === "SUCCEEDED"
          ? `本轮结束：候选 ${savedCount}/${targetCount} 条 · ${metricsCopy}${shortfall ? " · 未达目标" : ""}`
          : job?.status === "PAUSED" || job?.status === "CANCEL_REQUESTED" || job?.status === "QUEUED"
            ? `${labels[job.status]} · 已入台 ${savedCount}/${targetCount} 条`
            : `候选进度 ${percent}% · 已入台 ${savedCount}/${targetCount} 条 · ${metricsCopy} · 任务处理中`;
  el("collection-current-keyword").textContent = job?.currentKeyword ?? terminalKeywordCopy[job?.status] ?? "尚未开始";
  el("collection-progress-text").textContent = job ? progressCopy : "输入关键词后开始";
  el("collection-progress-fill").style.width = `${percent}%`;
  el("collection-progress-track").setAttribute("aria-valuenow", String(percent));
  el("collection-keyword-count").textContent = `${savedCount}/${targetCount}`;
  el("collection-seed-progress").textContent = `${completed}/${total}`;
  const relatedCount = current ? queue.filter((item) => item.parentKeywordId === current.keywordId || item.parentId === current.keywordId).length : 0;
  el("collection-related-count").textContent = formatNumber(relatedCount);
  el("collection-depth").textContent = formatNumber(current?.depth ?? job?.settings?.maxDepth ?? 0);
  el("collection-total-note-count").textContent = formatNumber(savedCount);
  el("collection-saved-count").textContent = formatNumber(savedCount);
  el("collection-comment-count").textContent = formatNumber(counters.retainedComments ?? state.runtime?.browserBridge?.lastSnapshot?.ingestion?.retainedComments ?? 0);
  el("collection-gap-count").textContent = formatNumber(counters.rejectedNotes ?? counters.failed ?? counters.blocked ?? 0);
  el("pause-collection").disabled = !active || job?.status === "PAUSED" || job?.status === "CANCEL_REQUESTED";
  el("resume-collection").disabled = job?.status !== "PAUSED";
  el("collect-notes").disabled = !active || progress?.runKind === "RANKING" || job?.settings?.autoCollectNotes === true;
  el("collect-notes").textContent = job?.settings?.autoCollectNotes === true ? "正在采笔记" : "采笔记";
  el("cancel-collection").disabled = !active;
  for (const [id, format] of [["export-research-json", "json"], ["export-research-csv", "csv"], ["export-research-md", "md"]]) el(id).href = `/api/research-export?format=${format}${job ? `&runId=${encodeURIComponent(job.runId)}` : ""}`;
  const visibleKeywords = queue.filter((item) => item.status !== "QUEUED").slice(-8).reverse();
  el("collection-keyword-list").innerHTML = visibleKeywords.length ? visibleKeywords.map((item) => `<div><span class="keyword-state ${item.status.toLowerCase()}">${esc(labels[item.status] ?? item.status)}</span><strong>${esc(item.value)}</strong><small>详情补证 ${formatNumber(item.savedNotes)} · 高价值评论 ${formatNumber(item.retainedComments)}</small></div>`).join("") : `<span>尚无关键词进度</span>`;
  const observedRows = (state.liveRanking?.rows ?? []).filter((row) => (job?.keywords ?? []).some((keyword) => row.sourceScope === `搜索结果：${keyword.value}`));
  const opportunities = job?.insights?.keywordOpportunities?.length ? job.insights.keywordOpportunities : (job?.keywords ?? []).map((keyword) => {
    const cards = observedRows.filter((row) => row.sourceScope === `搜索结果：${keyword.value}`);
    return { keyword: keyword.value, cardCount: cards.length, savedNotes: cards.filter((row) => row.evidenceStatus === "ELIGIBLE").length, retainedComments: 0, score: cards.reduce((sum, row) => sum + (row.opportunityScore ?? 0), 0) };
  }).filter((item) => item.cardCount > 0).sort((a, b) => b.score - a.score);
  el("collection-opportunities").className = `collection-insight-list${opportunities.length ? "" : " empty-state"}`;
  el("collection-opportunities").innerHTML = opportunities.length ? opportunities.slice(0, 8).map((item, index) => `<div><span>${index + 1}</span><div><strong>${esc(item.keyword)}</strong><small>${item.cardCount} 个搜索候选 · ${item.savedNotes} 条完整资料</small></div><b>${formatNumber(item.score)}</b></div>`).join("") : savedCount ? "已找到搜索候选；正在核对关键词归属" : "本轮暂无可展示的机会词；可换词再采";
  const accountCounts = new Map();
  for (const row of observedRows) if (row.author && row.author !== "作者未采到") { const item = accountCounts.get(row.author) ?? { authorName: row.author, appearances: 0, keywords: new Set(), totalLikes: 0 }; item.appearances += 1; item.keywords.add(row.sourceScope?.replace(/^搜索结果[：:]/, "") ?? ""); item.totalLikes += row.likes ?? 0; accountCounts.set(row.author, item); }
  const accounts = (job?.insights?.competitorAccounts?.length ? job.insights.competitorAccounts : [...accountCounts.values()].map((item) => ({ ...item, keywords: [...item.keywords] }))).filter((item) => item.appearances >= 2).sort((a, b) => b.appearances - a.appearances);
  el("collection-accounts").className = `collection-insight-list${accounts.length ? "" : " empty-state"}`;
  el("collection-accounts").innerHTML = accounts.length ? accounts.slice(0, 8).map((item) => `<div><span>${item.appearances}×</span><div><strong>${esc(item.authorName)}</strong><small>${esc(item.keywords.join("、"))} · 已见点赞 ${formatNumber(item.totalLikes)}</small></div></div>`).join("") : "本轮没有重复出现的账号；这不影响候选帖子入榜";
  el("collection-history").className = `record-list${runs.length ? "" : " empty-state"}`;
  el("collection-history").innerHTML = runs.length ? runs.slice(0, 10).map((item) => `<div class="record"><span class="badge ${item.status === "SUCCEEDED" && Number(item.counters?.admittedCards ?? item.counters?.ingestedCandidates ?? 0) >= Number(item.settings?.searchLimit ?? 0) ? "good" : ["FAILED", "BLOCKED", "CANCELLED"].includes(item.status) ? "block" : "warn"}">${esc(labels[item.status] ?? item.status)}</span><div><strong>${esc(item.seeds?.join("、") || item.keywords?.slice(0, 3).map((keyword) => keyword.value).join("、") || "关键词采集")} · 搜索候选 ${formatNumber(item.counters?.admittedCards ?? item.counters?.ingestedCandidates ?? 0)} 条</strong><small>完整资料 ${formatNumber(item.counters?.savedNotes ?? 0)} 条 · ${new Date(item.finishedAt ?? item.updatedAt).toLocaleString("zh-CN")}</small></div></div>`).join("") : "尚无运行历史";
  renderBrowserTasks();
}
function renderBrowserTasks() {
  const tasks = state.runtime?.browserTasks ?? [];
  el("browser-queue-count").textContent = `${tasks.length} 个任务`;
  el("browser-task-list").className = `record-list${tasks.length ? "" : " empty-state"}`;
  el("browser-task-list").innerHTML = tasks.length ? tasks.map((task) => `<div class="record"><span class="badge ${task.status === "SUCCEEDED" ? "good" : ["BLOCKED", "FAILED"].includes(task.status) ? "block" : "warn"}">${esc(task.status)}</span><div><strong>${esc(task.expectedPageType)} · 优先级 ${task.priority}</strong><small>${esc(task.taskId)} · 尝试 ${task.attempts}/${task.maxAttempts}</small><small title="${esc(task.targetUrl)}">${esc(task.targetUrl)}</small>${task.receiptId ? `<small>证据：${esc(task.receiptId)}</small>` : ""}${task.error ? `<small>当前错误：${esc(task.error.code)} · ${esc(task.error.message)}</small>` : ""}${task.attemptHistory?.length ? `<details><summary>历史失败 ${task.attemptHistory.length} 次</summary>${task.attemptHistory.map((item) => `<small>第 ${item.attempt} 次 · ${esc(item.at)} · ${esc(item.code)} · ${esc(item.message)}</small>`).join("")}</details>` : ""}</div></div>`).join("") : "尚无浏览器任务";
  const ingestion = state.runtime?.browserBridge?.lastSnapshot?.ingestion;
  const ingestionError = state.runtime?.browserBridge?.lastSnapshot?.ingestionError;
  el("browser-ingestion-state").innerHTML = ingestion
    ? `<span class="badge ${["NORMALIZED", "NORMALIZED_WITH_GAPS"].includes(ingestion.status) ? "good" : "warn"}">${esc(ingestion.status)}</span><div><strong>正式证据入库：${ingestion.envelopeIds?.length ?? 0} 个信封，标准化 ${ingestion.normalizedNoteIds?.length ?? 0} 条</strong><small>${ingestion.gaps?.length ? `仍有缺口：${esc(ingestion.gaps.join("、"))}` : "本次链路无已知缺口"}</small></div>`
    : ingestionError ? `<span class="badge block">INGESTION_FAILED</span><div><strong>正式入库失败</strong><small>${esc(ingestionError)}</small></div>` : "尚无真实浏览器证据入库回执";
}
function renderConnections() {
  const bridge = state.runtime?.browserBridge ?? { connectionStatus: "NOT_CONNECTED", activeClientCount: 0 };
  const latestClient = bridge.latestClient;
  const statusLabels = { CONNECTED: "扩展在线", STALE: "心跳过期", NOT_CONNECTED: "未连接" };
  el("bridge-connection-status").textContent = statusLabels[bridge.connectionStatus] ?? bridge.connectionStatus;
  el("bridge-connection-status").className = `badge ${bridge.connectionStatus === "CONNECTED" ? "good" : bridge.connectionStatus === "STALE" ? "block" : "warn"}`;
  el("bridge-health-details").className = `record-list${latestClient ? "" : " empty-state"}`;
  el("bridge-health-details").innerHTML = latestClient
    ? `<div class="record"><span class="badge ${bridge.connectionStatus === "CONNECTED" && latestClient.versionStatus === "MATCHED" ? "good" : "block"}">${esc(latestClient.pageType)}</span><div><strong>扩展 ${esc(latestClient.extensionVersion)} · 页面脚本 ${esc(latestClient.contentScriptVersion || "待刷新")} · ${bridge.activeClientCount} 个活跃实例</strong><small>${latestClient.versionStatus === "MATCHED" ? "版本一致" : "请刷新小红书页面以加载新脚本"} · 最后心跳：${new Date(latestClient.receivedAt).toLocaleString("zh-CN")} · 连续执行 ${esc(latestClient.autoRunStatus)}</small><small title="${esc(latestClient.pageUrl)}">页面：${esc(latestClient.pageUrl || "未记录")}</small><small>能力：${esc((latestClient.capabilities ?? []).join("、") || "未声明")}</small></div></div>`
    : "尚未收到扩展心跳；浏览器任务可以排队，但不会被标记为正在执行。";
  const validation = bridge.lastFieldValidation ?? bridge.lastSnapshot?.fieldValidation;
  const comparison = bridge.lastHumanComparison;
  const validationStatus = validation?.overallStatus ?? "NOT_STARTED";
  const validationLabels = { READY_FOR_HUMAN_COMPARE: "待人工逐字段对照", FIELD_GAPS: "存在字段缺口", BLOCKED: "字段核验阻断", CONTRACT_ONLY: "仅契约测试", NOT_STARTED: "尚未开始" };
  el("field-validation-status").textContent = validationLabels[validationStatus] ?? validationStatus;
  el("field-validation-status").className = `badge ${validationStatus === "READY_FOR_HUMAN_COMPARE" ? "warn" : validationStatus === "NOT_STARTED" ? "warn" : "block"}`;
  el("field-validation-details").className = `record-list${validation ? "" : " empty-state"}`;
  el("field-validation-details").innerHTML = validation
    ? `<div class="record"><span class="badge ${validation.evidenceClass === "REAL_VISIBLE_PAGE" && validation.machineCoverageStatus === "COMPLETE" ? "good" : "block"}">${esc(validation.evidenceClass)}</span><div><strong>${esc(validation.pageType)} · 已观察 ${validation.summary.presentFields}/${validation.summary.totalFields} 个字段</strong><small>机器覆盖 ${esc(validation.machineCoverageStatus)} · 必填缺口 ${validation.summary.requiredGaps} · 可选缺口 ${validation.summary.optionalGaps} · 人工对照 ${esc(validation.humanComparisonStatus)}</small><small>${validation.gaps?.length ? `缺口：${esc(validation.gaps.join("、"))}` : "机器覆盖无已知缺口，仍不得替代人工逐字段对照"}</small></div></div>`
    : "尚无真实页面字段核验回执；离线夹具与历史快照不等于真实平台验收。";
  const canCompare = validation?.evidenceClass === "REAL_VISIBLE_PAGE";
  el("human-comparison-submit").disabled = !canCompare;
  el("human-comparison-fields").className = `span-2 record-list${canCompare ? "" : " empty-state"}`;
  el("human-comparison-fields").innerHTML = canCompare
    ? validation.fields.map((field) => `<div class="record human-field-row" data-human-field="${esc(field.key)}"><span class="badge ${field.present ? "good" : "block"}">${field.present ? "机器有值" : "机器缺失"}</span><div><strong>${esc(field.key)} · ${field.required ? "必填" : "可选"}</strong><small>${esc(field.section)}${field.gapCode ? ` · ${esc(field.gapCode)}` : ""}</small><select class="human-field-verdict" aria-label="${esc(field.key)} 人工判定"><option value="">选择判定</option><option value="MATCH" ${field.present ? "" : "disabled"}>一致</option><option value="MISMATCH">不一致</option><option value="NOT_OBSERVABLE">页面不可观察</option></select><input class="human-field-note" placeholder="备注（可选）" maxlength="500" /></div></div>`).join("")
    : validation?.evidenceClass === "CONTRACT_TEST" ? "契约测试回执不得进入真实页面人工验收。" : "收到真实页面回执后显示逐字段判定项。";
  const matchingComparison = comparison?.fieldValidationReceiptId === validation?.receiptId ? comparison : null;
  const comparisonLabels = { PASS: "人工对照通过", FAIL: "人工对照不一致", INCOMPLETE: "人工对照未闭环" };
  el("human-comparison-result").className = `span-2 record-list${matchingComparison ? "" : " empty-state"}`;
  el("human-comparison-result").innerHTML = matchingComparison
    ? `<div class="record"><span class="badge ${matchingComparison.humanComparisonStatus === "PASS" ? "good" : "block"}">${esc(matchingComparison.humanComparisonStatus)}</span><div><strong>${comparisonLabels[matchingComparison.humanComparisonStatus] ?? esc(matchingComparison.humanComparisonStatus)}</strong><small>一致 ${matchingComparison.summary.matches} · 不一致 ${matchingComparison.summary.mismatches} · 不可观察 ${matchingComparison.summary.notObservable}</small><small>${esc(matchingComparison.comparisonId)} · SHA256 ${esc(matchingComparison.sha256)}</small></div></div>`
    : "当前字段回执尚无人工对照回执。";
  const accounts = state.connections?.matrixAccounts ?? [];
  el("matrix-list").className = `record-list${accounts.length ? "" : " empty-state"}`;
  el("matrix-list").innerHTML = accounts.length ? accounts.map((item) => `<div class="record"><span class="badge ${item.enabled ? "good" : "warn"}">${item.enabled ? "启用" : "停用"}</span><div><strong>${esc(item.label)} · ${esc(item.accountId)}</strong><small>${esc(item.profileHint || "未填写用途")}</small></div><button class="secondary remove-account" data-account-id="${esc(item.accountId)}" type="button">移除</button></div>`).join("") : "尚未登记账号";
  document.querySelectorAll(".remove-account").forEach((button) => button.addEventListener("click", async () => { const next = accounts.filter((item) => item.accountId !== button.dataset.accountId); await saveMatrixAccounts(next); }));
  const feishu = state.connections?.feishu ?? { enabled: false, webhookEnv: "FEISHU_WEBHOOK_URL", configured: false };
  el("feishu-env").value = feishu.webhookEnv; el("feishu-enabled").checked = feishu.enabled;
  el("feishu-status").textContent = feishu.configured ? "环境变量已配置" : "缺少环境变量"; el("feishu-status").className = `badge ${feishu.configured ? "good" : "warn"}`;
}
async function loadConnections() { state.connections = await api("/api/connections"); renderConnections(); }
async function saveMatrixAccounts(accounts) { try { await api("/api/connections/matrix", { method: "PUT", body: JSON.stringify({ accounts }) }); await loadConnections(); toast("矩阵账号配置已保存", "success"); } catch (error) { toast(`保存失败：${error.message}`, "error"); } }
async function submitHumanComparison(event) {
  event.preventDefault();
  const validation = state.runtime?.browserBridge?.lastFieldValidation ?? state.runtime?.browserBridge?.lastSnapshot?.fieldValidation;
  if (!validation || validation.evidenceClass !== "REAL_VISIBLE_PAGE") return toast("当前没有可人工验收的真实页面回执", "error");
  const rows = [...document.querySelectorAll("[data-human-field]")];
  const verdicts = rows.map((row) => ({ key: row.dataset.humanField, verdict: row.querySelector(".human-field-verdict").value, note: row.querySelector(".human-field-note").value }));
  if (verdicts.some((item) => !item.verdict)) return toast("每个字段都必须选择人工判定", "error");
  try {
    await api(`/api/browser-bridge/field-validation/${encodeURIComponent(validation.receiptId)}/human-comparison`, { method: "POST", body: JSON.stringify({ comparisonBasis: "SIDE_BY_SIDE_VISIBLE_PAGE", confirmedVisiblePage: el("human-comparison-confirmed").checked, observedSourceUrl: el("human-comparison-source-url").value.trim(), reviewer: el("human-comparison-reviewer").value.trim(), verdicts }) });
    await loadCore(); renderConnections(); toast("人工逐字段核验回执已保存", "success");
  } catch (error) { toast(`人工核验保存失败：${error.message}`, "error"); }
}
function renderProviders() {
  const provider = state.providers.providers.find((item) => item.providerId === state.selectedProviderId) ?? state.providers.providers.find((item) => item.enabled) ?? state.providers.providers[0];
  if (!provider) return;
  const selectedRoute = state.providers.routes.find((route) => route.task === "DECISION_SUPPORT" && route.providerId === provider.providerId && route.modelId);
  const inferenceReady = selectedRoute && state.modelInference?.providerId === provider.providerId && state.modelInference?.modelId === selectedRoute.modelId;
  const apiEnabled = state.providers.apiEnabled === true;
  const connectionText = !apiEnabled ? "模型 API 已关闭" : inferenceReady ? "推理已验证" : provider?.verified ? "模型列表已连接" : provider?.apiKeyConfigured ? "待测试" : "尚未连接";
  el("model-connection-status").textContent = connectionText;
  el("model-connection-status").className = `badge ${apiEnabled && inferenceReady ? "good" : "warn"}`;
  el("provider-cards").innerHTML = `<div class="connector-form" data-provider="${esc(provider.providerId)}"><label class="model-api-switch"><input id="model-api-enabled" type="checkbox" ${apiEnabled ? "checked" : ""} /><span><strong>启用模型 API</strong><small>${apiEnabled ? "已开启：模型列表和智能分析可使用模型 API" : "已关闭：不调用模型 API；普通联网采集照常运行"}</small></span></label><label>模型服务<select id="simple-provider-select">${state.providers.providers.map((item) => `<option value="${esc(item.providerId)}" ${item.providerId === provider.providerId ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></label><label>API 地址<input data-field="baseUrl" value="${esc(provider.baseUrl)}" /></label><label>API Key<input data-field="apiKey" type="password" autocomplete="off" placeholder="${provider.apiKeyConfigured ? "已安全保存；如需更换请重新输入" : "粘贴 API Key"}" /></label><input data-field="apiKeyEnv" value="${esc(provider.apiKeyEnv)}" hidden /><div class="connection-key-state ${provider.apiKeyConfigured ? "ready" : "missing"}"><strong data-key-title>${provider.apiKeyConfigured ? "API Key 已安全保存" : "请输入 API Key"}</strong><span data-key-help>地址和密钥保存在本机，密钥不回显；版本更新和服务重启不会清除，只有点击一键清除才删除。</span></div><div class="button-row"><button class="secondary save-provider" type="button">保存连接信息</button><button class="primary pull-models" type="button" ${apiEnabled ? "" : "disabled"}>测试连接并读取模型</button><button class="secondary clear-provider" type="button">一键清除</button></div><div class="catalog" data-catalog></div></div>`;
  document.querySelector("#model-api-enabled").addEventListener("change", updateModelApiMode);
  document.querySelector("#simple-provider-select").addEventListener("change", (event) => { state.selectedProviderId = event.target.value; renderProviders(); });
  document.querySelector(".save-provider").addEventListener("click", () => saveProvider(el("provider-cards").querySelector("[data-provider]")));
  document.querySelector(".pull-models").addEventListener("click", () => pullModels(el("provider-cards").querySelector("[data-provider]")));
  document.querySelector(".clear-provider").addEventListener("click", () => clearProvider(provider.providerId));
  const catalog = el("provider-cards").querySelector("[data-catalog]");
  const models = state.modelCatalogs[provider.providerId] ?? [];
  catalog.innerHTML = `${selectedRoute ? `<strong>当前使用：${esc(selectedRoute.modelId)}</strong>` : "尚未选择用于分析的模型"}${models.length ? `<label>选择要使用的模型<select data-simple-model>${models.map((model) => `<option value="${esc(model.id)}" ${model.id === selectedRoute?.modelId ? "selected" : ""}>${esc(model.id)}</option>`).join("")}</select></label><button class="primary use-simple-model" type="button">使用这个模型</button>` : ""}<div class="manual-model-row"><label>列表无法读取？直接填写模型 ID<input data-manual-model placeholder="例如 gpt-4.1-mini" value="${esc(selectedRoute?.modelId ?? "")}" /></label><button class="secondary use-manual-model" type="button">使用填写的模型</button></div>${selectedRoute && provider.apiKeyConfigured ? `<div class="model-test-row"><button class="secondary test-model-inference" type="button" ${apiEnabled ? "" : "disabled"}>测试真实推理</button><small>${apiEnabled ? inferenceReady ? `推理通过 · ${new Date(state.modelInference.finishedAt).toLocaleString("zh-CN")}` : "模型列表不等于推理可用；请主动测试" : "开启模型 API 后才能发起推理"}</small></div>` : ""}`;
  catalog.querySelector(".use-simple-model")?.addEventListener("click", () => useSimpleModel(provider.providerId, catalog.querySelector("[data-simple-model]").value));
  catalog.querySelector(".use-manual-model")?.addEventListener("click", () => useSimpleModel(provider.providerId, catalog.querySelector("[data-manual-model]").value.trim()));
  catalog.querySelector(".test-model-inference")?.addEventListener("click", () => testModelInference(provider, selectedRoute.modelId));
  const card = el("provider-cards").querySelector("[data-provider]");
  const draft = providerDrafts.get(provider.providerId);
  for (const field of ["baseUrl", "apiKey", "apiKeyEnv"]) {
    const input = card.querySelector(`[data-field="${field}"]`);
    if (draft && field in draft) input.value = draft[field];
    input.addEventListener("input", () => {
      const next = { ...(providerDrafts.get(provider.providerId) ?? {}) };
      for (const name of ["baseUrl", "apiKey", "apiKeyEnv"]) next[name] = card.querySelector(`[data-field="${name}"]`).value;
      providerDrafts.set(provider.providerId, next);
    });
  }
  const manual = catalog.querySelector("[data-manual-model]");
  if (manual) {
    if (draft?.manualModel !== undefined) manual.value = draft.manualModel;
    manual.addEventListener("input", () => providerDrafts.set(provider.providerId, { ...(providerDrafts.get(provider.providerId) ?? {}), manualModel: manual.value }));
  }
  renderRoutes();
}
function renderRoutes() {
  const providerOptions = `<option value="">未选择</option>${state.providers.providers.map((provider) => `<option value="${esc(provider.providerId)}">${esc(provider.label)}</option>`).join("")}`;
  el("route-list").innerHTML = state.providers.routes.map((route) => `<div class="route-row" data-task="${esc(route.task)}"><strong>${taskLabels[route.task]}</strong><select data-route-provider>${providerOptions}</select><select data-route-model><option value="${esc(route.modelId)}">${route.modelId ? esc(route.modelId) : "先拉取模型"}</option></select></div>`).join("");
  document.querySelectorAll(".route-row").forEach((row) => { const route = state.providers.routes.find((item) => item.task === row.dataset.task); const providerSelect = row.querySelector("[data-route-provider]"); providerSelect.value = route.providerId; populateModelSelect(row, route.modelId); providerSelect.addEventListener("change", () => populateModelSelect(row, "")); });
}
function populateModelSelect(row, selected) {
  const providerId = row.querySelector("[data-route-provider]").value; const models = state.modelCatalogs[providerId] ?? []; const select = row.querySelector("[data-route-model]"); select.innerHTML = `<option value="">${models.length ? "选择模型" : "先拉取模型"}</option>${models.map((model) => `<option value="${esc(model.id)}">${esc(model.id)}</option>`).join("")}`; if (selected && !models.some((model) => model.id === selected)) select.insertAdjacentHTML("beforeend", `<option value="${esc(selected)}">${esc(selected)}（已保存）</option>`); select.value = selected;
}
async function saveProvider(card, { quiet = false } = {}) {
  const id = card.dataset.provider;
  const apiKey = card.querySelector('[data-field="apiKey"]').value.trim();
  const submittedDraft = providerDrafts.get(id);
  try {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ baseUrl: card.querySelector('[data-field="baseUrl"]').value, apiKeyEnv: card.querySelector('[data-field="apiKeyEnv"]').value, apiKey, enabled: true }) });
    state.selectedProviderId = id;
    if (providerDrafts.get(id) === submittedDraft) {
      providerDrafts.delete(id);
      if (submittedDraft?.manualModel) providerDrafts.set(id, { manualModel: submittedDraft.manualModel });
      card.querySelector('[data-field="apiKey"]').value = "";
    }
    if (!quiet) { await loadProviders(); toast("连接信息已保存", "success"); }
    return true;
  } catch (error) { toast(`保存失败：${error.message}`, "error"); return false; }
}
async function updateModelApiMode(event) {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    await api("/api/model-api-mode", { method: "PUT", body: JSON.stringify({ enabled }) });
    state.providers.apiEnabled = enabled;
    if (!enabled) state.modelInference = null;
    renderProviders();
    toast(enabled ? "模型 API 已开启；普通采集仍走正常网络" : "模型 API 已关闭；普通联网采集不受影响", "success");
  } catch (error) { event.target.checked = !enabled; event.target.disabled = false; toast(`切换失败：${error.message}`, "error"); }
}
async function clearProvider(providerId) {
  if (!window.confirm("确定清除已保存的 API 地址、密钥和该服务的模型选择吗？清除后无法恢复。")) return;
  try {
    await api(`/api/providers/${encodeURIComponent(providerId)}/credentials`, { method: "DELETE" });
    delete state.modelCatalogs[providerId];
    providerDrafts.delete(providerId);
    state.modelInference = null;
    await loadProviders();
    toast("连接信息已清除，模型 API 已关闭", "success");
  } catch (error) { toast(`清除失败：${error.message}`, "error"); }
}
async function pullModels(card) {
  if (state.providers.apiEnabled !== true) return toast("请先开启模型 API；普通联网采集无需开启", "error");
  const id = card.dataset.provider;
  if (!window.confirm("这会向该模型服务发出一次真实联网请求，用于验证 API Key 并读取模型列表。是否继续？")) return;
  const button = card.querySelector(".pull-models");
  button.disabled = true;
  button.textContent = "正在连接…";
  const target = card.querySelector("[data-catalog]");
  try {
    const saved = await saveProvider(card, { quiet: true }); if (!saved) return;
    target.textContent = "正在读取模型列表，最多等待约 70 秒；也可稍后手动填写模型 ID。";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70_000);
    try {
      const result = await api(`/api/providers/${encodeURIComponent(id)}/models`, { method: "POST", body: JSON.stringify({ confirmExternalCall: true }), signal: controller.signal });
      state.modelCatalogs[id] = result.models;
      await loadProviders();
      toast(result.models.length ? "模型列表已读取，请选择模型并测试推理" : "服务未返回模型列表，可手动填写模型 ID", result.models.length ? "success" : "error");
    } finally { clearTimeout(timer); }
  } catch (error) {
    const detail = error.name === "AbortError" || error.name === "TimeoutError" ? "连接超时，请检查网络或代理；也可手动填写模型 ID" : /^MODEL_LIST_HTTP_401/.test(error.message) ? "模型列表返回 401，请检查密钥权限" : /^MODEL_LIST_HTTP_403/.test(error.message) ? "模型列表返回 403，当前密钥无权读取" : /^MODEL_LIST_HTTP_404/.test(error.message) ? "服务没有模型列表接口，可手动填写模型 ID" : /^MODEL_LIST_HTTP_429/.test(error.message) ? "模型服务限流，请稍后再试" : /fetch failed/i.test(error.message) ? "无法连接模型服务：请确认系统代理正在运行，再重新启动工作台" : `读取失败：${error.message}`;
    await loadProviders();
    el("provider-cards").querySelector("[data-catalog]").insertAdjacentHTML("afterbegin", `<p class="model-list-error">${esc(detail)}</p>`);
  } finally {
    button.disabled = false;
    button.textContent = "测试连接并读取模型";
  }
}
async function useSimpleModel(providerId, modelId) {
  if (!modelId) return toast("请先选择模型", "error");
  const routes = Object.keys(taskLabels).map((task) => ({ task, providerId, modelId, fallbackProviderIds: [] }));
  try { await api("/api/model-routes", { method: "PUT", body: JSON.stringify({ routes }) }); state.modelInference = null; await loadProviders(); toast(`已选择 ${modelId}，请测试真实推理`, "success"); }
  catch (error) { toast(`模型保存失败：${error.message}`, "error"); }
}
async function testModelInference(provider, modelId) {
  if (state.providers.apiEnabled !== true) return toast("模型 API 已关闭，不能发起推理", "error");
  if (!window.confirm(`这会向 ${provider.label} 的 ${modelId} 发出一次真实推理请求，可能产生费用。是否继续？`)) return;
  const button = el("provider-cards").querySelector(".test-model-inference");
  button.disabled = true; button.textContent = "测试中…";
  try {
    const result = await api("/api/model/analyze", { method: "POST", body: JSON.stringify({ confirmExternalCall: true, providerId: provider.providerId, modelId, task: "DECISION_SUPPORT", requireJson: true, systemPrompt: "只返回合法 JSON：{\"ok\":true}。", evidencePacket: { purpose: "connection-test" } }) });
    if (result.parsedJson?.ok !== true || result.receipt?.status !== "SUCCEEDED") throw new Error("模型未返回预期的 JSON 结果");
    state.modelInference = { providerId: provider.providerId, modelId, finishedAt: result.receipt.finishedAt };
    renderProviders(); toast("真实推理测试通过，模型可用于分析", "success");
  } catch (error) { state.modelInference = null; renderProviders(); toast(`推理测试失败：${error.message}`, "error"); }
}
async function loadProviders() { state.providers = await api("/api/providers"); renderProviders(); }
async function enhanceRecommendation(noteId) {
  if (state.modelAnalysisPending) return toast("已有模型分析正在进行，请稍候", "info");
  if (!state.providers) await loadProviders();
  if (state.providers.apiEnabled !== true) return toast("模型 API 已关闭；普通采集仍可继续", "error");
  const route = state.providers.routes.find((item) => item.task === "DECISION_SUPPORT" && item.providerId && item.modelId);
  const provider = route && state.providers.providers.find((item) => item.providerId === route.providerId);
  if (!route || !provider?.apiKeyConfigured) return toast("请先在“模型连接”中配置密钥并选择模型", "error");
  if (!window.confirm(`这会向 ${provider.label} 的 ${route.modelId} 发出一次真实分析请求。是否继续？`)) return;
  const row = state.liveRanking?.rows?.find((item) => item.noteId === noteId); const note = liveNoteFor(noteId);
  if (!row) return toast("这条内容的实时数据已变化，请刷新后重试", "error");
  state.modelAnalysisPending = noteId;
  renderResearchWorkspace();
  try {
    const result = await api("/api/model/analyze", { method: "POST", body: JSON.stringify({ confirmExternalCall: true, providerId: route.providerId, modelId: route.modelId, task: "DECISION_SUPPORT", requireJson: true, systemPrompt: "你是小红书内容运营分析师。只依据给定证据输出JSON，字段为 recommendedAngle 字符串、whyItWorks 字符串、executionSteps 字符串数组、risks 字符串数组。不得虚构未采集事实，必须把缺失证据写入 risks。", evidencePacket: { ranking: row, note: note ? { title: note.title, body: note.body, keywords: note.keywords, metrics: note.metrics } : null, comments: commentFragments(noteId), localRecommendation: state.recommendation } }) });
    const insight = result.parsedJson;
    if (result.receipt?.status !== "SUCCEEDED" || !insight || typeof insight.recommendedAngle !== "string" || typeof insight.whyItWorks !== "string" || !Array.isArray(insight.executionSteps) || !Array.isArray(insight.risks) || ![...insight.executionSteps, ...insight.risks].every(item => typeof item === "string")) throw new Error("模型结果不完整，未作为分析结论展示");
    state.modelInsight = { ...insight, noteId, providerId: result.receipt.providerId, modelId: result.receipt.modelId, finishedAt: result.receipt.finishedAt };
    renderSharedRecommendation(); toast("分析已显示在对应参考帖子下方", "success");
  } catch (error) { toast(`模型分析失败：${error.message}`, "error"); }
  finally { state.modelAnalysisPending = null; renderResearchWorkspace(); }
}
async function loadCore() {
  if (state.coreLoading) return state.coreLoading;
  state.coreLoading = (async () => {
  const [report, database, liveDatabase, runtime, databaseStatus, viewResult, selectedResult, projectState, marketState] = await Promise.all([api("/api/report"), api("/api/database"), api("/api/browser-bridge/database"), api("/api/status"), api("/api/database/status"), api("/api/database/views"), api("/api/database/notes?tag=%E9%87%8D%E7%82%B9%E8%B7%9F%E8%BF%9B&limit=500"), api("/api/project-state"), api("/api/market-state")]);
  const admittedNoteIds = admittedWorkbenchNoteIds(liveDatabase);
  const liveRanking = buildLiveRanking(liveDatabase);
  const nextRankingSignature = rankingDataSignature(liveRanking);
  const autoTopics = buildAutoTopics(liveRanking);
  Object.assign(state, { report, database, liveDatabase, admittedNoteIds, runtime, databaseStatus, projectState, marketState, databaseViews: viewResult.views, liveSearchNotes: selectedResult.notes.filter((note) => admittedNoteIds.has(note.noteId)), liveRanking, autoTopics, recommendation: buildContentRecommendation(liveRanking, { direction: projectState.direction }) });
  const monitor = runtime.rankingMonitor ?? {};
  const collectorRunning = runtime.realCollector?.status === "RUNNING" || monitor.captureActive === true;
  const runtimeMode = collectorRunning
    ? "榜单正在更新"
    : monitor.mode === "REAL_ADAPTER" && monitor.targetUrl
      ? "使用期间每小时检查"
      : state.liveRanking.rows.length
        ? "等待下次检查"
        : "等待首次榜单";
  el("server-state").textContent = "已连接"; el("runtime-mode").textContent = runtimeMode; el("server-light").className = "status-light";
  if (state.liveRanking.rows.length) setNotice("本地样本已同步", `共 ${state.liveRanking.rows.length} 条已采集候选；不代表全站完整数据，也不代表本次新增。`, "info");
  else setNotice("暂时还没有实时爆款", "连接小红书后系统会自动更新；在此之前不会用演示数据冒充真实趋势。", "warn");
  renderSharedRecommendation(); renderTodayOverview(); renderDatabase(); renderAnalysis(); renderDecision(); renderRanking(); renderMarket(); renderFavorites(); renderCollection(); renderDetail();
  if (state.pendingRefresh) {
    const feedback = pendingRefreshFeedback(state.pendingRefresh, nextRankingSignature, Date.now(), runtime);
    setRefreshFeedback(feedback.message, feedback.tone);
    if (feedback.done) { state.pendingRefresh = null; state.refreshOutcome = feedback; }
  } else {
    if (state.refreshOutcome?.tone === "error") setRefreshFeedback(state.refreshOutcome.message, "error");
    else setRefreshFeedback(`已读取本地快照 · ${state.liveRanking.rows.length} 条候选 · ${new Date().toLocaleTimeString("zh-CN")}`, "muted");
  }
  state.rankingSignature = nextRankingSignature;
  state.lastCoreLoadedAt = Date.now();
  state.runtimeSignature = runtimeTransitionSignature(runtime);
  })();
  try { await state.coreLoading; } finally { state.coreLoading = null; }
}
function runtimeTransitionSignature(runtime) {
  const summarize = (items = []) => items.slice(0, 5).map((item) => `${item.runId ?? item.taskId}:${item.status}:${item.updatedAt ?? ""}`).join("|");
  return [runtime?.realCollector?.status, runtime?.rankingMonitor?.captureActive, summarize(runtime?.rankingRuns), summarize(runtime?.keywordRuns), runtime?.browserBridge?.lastSnapshot?.receiptId].join("::");
}
function runtimeIsActive(runtime) {
  return runtime?.realCollector?.status === "RUNNING" || runtime?.rankingMonitor?.captureActive === true || [...(runtime?.rankingRuns ?? []), ...(runtime?.keywordRuns ?? [])].some((run) => ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(run.status));
}
async function loadRuntimeSummary() {
  const previousSignature = state.runtimeSignature;
  const summary = await api("/api/runtime-summary");
  state.runtime = { ...(state.runtime ?? {}), ...summary };
  state.runtimeSignature = runtimeTransitionSignature(state.runtime);
  el("server-state").textContent = "已连接";
  el("server-light").className = "status-light";
  if (previousSignature !== state.runtimeSignature) renderRanking();
  renderCollection();
  return summary;
}
async function pollRuntimeStatus() {
  if (document.hidden) return;
  try {
    await refreshCoordinator.poll(async () => {
    const wasActive = runtimeIsActive(state.runtime);
    const previousSignature = state.runtimeSignature;
    const runtime = await loadRuntimeSummary();
    const active = runtimeIsActive(runtime);
    const due = Date.now() - state.lastCoreLoadedAt >= (active ? 2000 : 60000);
    if ((wasActive && !active) || previousSignature !== state.runtimeSignature || due) await loadCore();
    }, { active: runtimeIsActive(state.runtime), hidden: document.hidden });
  } catch { el("server-state").textContent = "连接中断"; el("server-light").className = "status-light offline"; }
}
async function refreshView(view) {
  try { if (view === "models") await loadProviders(); else if (view === "history") { await Promise.all([loadCore(), loadViewHistory()]); } else if (view === "connections") { await Promise.all([loadConnections(), loadCore()]); renderConnections(); } else await loadCore(); } catch (error) { setNotice("数据加载失败", error.message, "error"); toast(`刷新失败：${error.message}`, "error"); }
}

async function syncAllViews() {
  return refreshCoordinator.single("sync", async () => {
    await Promise.all([loadCore(), loadViewHistory(), loadConnections(), loadProviders()]);
  });
}

async function dispatchDirectionRefresh() {
  if (state.marketDraftDirty && el("market-direction").value.trim()) {
    const direction = el("market-direction").value.trim();
    const preciseTerms = el("market-terms").value.split(/[，,、;；\n]+/).map((term) => term.trim()).filter(Boolean);
    const draftRevision = state.marketDraftRevision;
    state.marketState = await api("/api/market-state/direction", { method: "PUT", body: JSON.stringify({ direction, preciseTerms }) });
    if (state.marketDraftRevision === draftRevision) state.marketDraftDirty = false;
  }
  const direction = String(state.marketState?.direction ?? "").trim();
  if (!direction) return { status: "NO_DIRECTION" };
  const active = state.runtime?.keywordRuns?.find((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status));
  if (active) return { status: "ALREADY_ACTIVE", runId: active.runId };
  const terms = (state.marketState?.preciseTerms ?? []).map((term) => String(term).trim()).filter(Boolean);
  const seeds = [...new Set([direction, ...terms])].slice(0, 5).join("\n");
  const target = Number(el("collection-target").value);
  const settings = { searchLimit: Number.isInteger(target) && target >= 1 && target <= 10000 ? target : 100, maxDepth: 1, maxKeywords: 10, maxChildrenPerKeyword: 5, notesPerKeyword: 1, requestIntervalMs: 500, slowNetworkMaxWaitMs: 120000, searchScope: "ALL_EXPANDED", collectionMethod: "TOP_N", autoCollectNotes: true, completeMetrics: true };
  const plan = await api("/api/keywords/plan", { method: "POST", body: JSON.stringify({ seeds, maxDepth: settings.maxDepth, maxKeywords: settings.maxKeywords, maxChildrenPerKeyword: settings.maxChildrenPerKeyword, noteDetailsPerKeyword: 1, maxEstimatedNoteDetails: 10 }) });
  return api("/api/keywords/run", { method: "POST", body: JSON.stringify({ plan, settings }) });
}

async function runRealRefresh() {
  if (state.realRefreshActive) return toast("本次更新正在发起，请稍候", "info");
  state.realRefreshActive = true;
  state.refreshOutcome = null;
  state.pendingRefresh = { baseline: state.rankingSignature || rankingDataSignature(state.liveRanking), startedAt: Date.now(), completed: false };
  setRefreshFeedback("正在更新，请稍候…", "loading");
  for (const button of [el("refresh"), el("live-ranking-refresh"), el("history-refresh")]) { button.disabled = true; button.dataset.previousText = button.textContent; button.textContent = "正在更新…"; }
  setNotice("正在搜罗真实榜单", "系统会在已打开的小红书标签页内收集搜索卡片；视频不自动打开，候选数据发现后立即入台。", "info");
  renderRanking();
  try {
    const beforeSignature = state.pendingRefresh.baseline;
    const [rankingResult, directionResult] = await Promise.allSettled([
      api("/api/ranking/refresh", { method: "POST", body: "{}" }),
      dispatchDirectionRefresh(),
    ]);
    if (rankingResult.status === "rejected" && directionResult.status === "rejected") throw new Error(`全站：${rankingResult.reason.message}；我的方向：${directionResult.reason.message}`);
    const receipt = rankingResult.status === "fulfilled" ? rankingResult.value : null;
    const directionReceipt = directionResult.status === "fulfilled" ? directionResult.value : null;
    state.pendingRefresh.targets = [
      receipt?.browserTaskId ? { taskId: receipt.browserTaskId } : { status: receipt?.status === "SUCCEEDED" ? "SUCCEEDED" : rankingResult.status === "rejected" ? "FAILED" : receipt?.status },
      directionReceipt?.run?.runId || directionReceipt?.runId ? { runId: directionReceipt?.run?.runId ?? directionReceipt.runId } : { status: directionReceipt?.status === "NO_DIRECTION" ? "SUCCEEDED" : "FAILED" },
    ];
    await syncAllViews();
    const outcome = receipt ? describeRefreshOutcome({ receipt, beforeSignature, afterSignature: rankingDataSignature(state.liveRanking), afterCount: state.liveRanking?.rows?.length ?? 0 }) : { message: "全站检查未派发", tone: "error" };
    const directionMessage = directionReceipt?.run ? "我的方向采集已派发" : directionReceipt?.status === "ALREADY_ACTIVE" ? "我的方向采集正在进行" : directionReceipt?.status === "NO_DIRECTION" ? "尚未设置我的方向" : `我的方向更新失败：${directionResult.reason?.message ?? "未知原因"}`;
    if ((receipt?.status === "DISPATCHED" || directionReceipt?.run) && state.pendingRefresh) {
      const dispatched = [receipt?.status === "DISPATCHED" ? "全站检查" : null, directionReceipt?.run ? "我的方向采集" : null].filter(Boolean).join("、");
      setRefreshFeedback(`${dispatched}已发起，等待新数据 · ${new Date().toLocaleTimeString("zh-CN")}`, "loading");
    }
    toast(`${outcome.message}；${directionMessage}`, directionResult.status === "rejected" || rankingResult.status === "rejected" ? "error" : outcome.tone);
  } catch (error) {
    await syncAllViews().catch(() => {});
    setNotice("真实榜单更新失败", error.message, "error");
    setRefreshFeedback(`更新失败：${error.message}`, "error");
    state.pendingRefresh = null;
    state.refreshOutcome = { tone: "error", message: `更新失败：${error.message}` };
    toast(`更新失败：${error.message}`, "error");
  } finally {
    state.realRefreshActive = false;
    for (const button of [el("refresh"), el("live-ranking-refresh"), el("history-refresh")]) { button.disabled = false; button.textContent = button.dataset.previousText || "更新"; }
    renderRanking();
  }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-market-hours]").forEach((button) => button.addEventListener("click", () => {
  state.marketHours = Number(button.dataset.marketHours);
  document.querySelectorAll("[data-market-hours]").forEach((item) => { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", String(item === button)); });
  renderMarket();
  renderRanking();
}));
el("market-all-more").addEventListener("click", () => { state.marketExpanded.all = !state.marketExpanded.all; renderMarket(); });
el("market-direction-more").addEventListener("click", () => { state.marketExpanded.direction = !state.marketExpanded.direction; renderMarket(); });
el("market-drill-more").addEventListener("click", () => { state.marketDrillExpanded = !state.marketDrillExpanded; renderMarketDrill(); });
el("market-drill-close").addEventListener("click", () => { state.marketDrillCollapsed = !state.marketDrillCollapsed; renderMarketDrill(); });
function directionFeedback(message, tone = "") {
  const feedback = el("direction-feedback");
  feedback.textContent = message;
  feedback.className = `direction-feedback ${tone}`;
}
for (const id of ["market-direction", "market-terms"]) el(id).addEventListener("input", () => {
  state.marketDraftDirty = true; state.marketDraftRevision += 1;
  el("market-direction").removeAttribute("aria-invalid");
  directionFeedback("有未保存的修改；保存后替换当前方向，不会自动开始采集。");
});
el("market-direction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.directionSaving) return;
  const direction = el("market-direction").value.trim();
  if (!direction) {
    directionFeedback("请填写方向描述；精确关键词不能替代方向描述。", "error");
    el("market-direction").setAttribute("aria-invalid", "true");
    el("market-direction").focus();
    return;
  }
  const preciseTerms = el("market-terms").value.split(/[，,、;；\n]+/).map((term) => term.trim()).filter(Boolean);
  const draftRevision = state.marketDraftRevision;
  state.directionSaving = true;
  const saveButton = el("market-direction-save");
  saveButton.disabled = true; saveButton.textContent = "正在保存…";
  directionFeedback("正在保存方向…");
  try {
    state.marketState = await api("/api/market-state/direction", { method: "PUT", body: JSON.stringify({ direction, preciseTerms }) });
    if (state.marketDraftRevision === draftRevision) state.marketDraftDirty = false;
    state.marketDrill = null; renderMarket(); renderFavorites();
    el("seed-keywords").value = directionTerms(direction, preciseTerms).join("\n");
    try { saveDraft(); } catch { /* Browser storage must not turn a successful server save into a failure. */ }
    directionFeedback(state.marketDraftDirty ? "上一版已保存；你刚输入的新修改仍未保存。" : "已保存。点击“更新”检查当前方向与全站；保存本身不启动采集。", state.marketDraftDirty ? "" : "success");
    toast("方向已保存；旧方向已归档。采集页已填入新方向，可手动开始采集。", "success");
  } catch (error) {
    directionFeedback(`保存失败：${error.message}。输入已保留，可再次保存。`, "error");
  } finally {
    state.directionSaving = false;
    saveButton.disabled = false; saveButton.textContent = "保存方向";
  }
});
window.addEventListener("hashchange", () => switchView(location.hash.slice(1), { updateHash: false, recordHistory: false }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  setRefreshFeedback("正在同步后台采集结果…", "loading");
  syncAllViews().then(() => {
    if (state.pendingRefresh || state.refreshOutcome?.tone === "error") return;
    setRefreshFeedback(state.pendingRefresh ? "已读取本地快照；新一轮更新仍在进行" : `已读取本地快照 · ${state.liveRanking?.rows?.length ?? 0} 条候选 · ${new Date().toLocaleTimeString("zh-CN")}`, state.pendingRefresh ? "loading" : "success");
  }).catch((error) => {
    setRefreshFeedback(`同步失败：${error.message}`, "error");
    toast(`同步失败：${error.message}`, "error");
  });
  reportWorkbenchPresence();
});
async function reportWorkbenchPresence() {
  if (document.hidden) return;
  try {
    const result = await api("/api/workbench-presence", { method: "POST", body: JSON.stringify({ active: true }) });
    if (result.outcome === "DISPATCHED") setRefreshFeedback("进入页面后已发起补偿更新，等待采集卡片…", "loading");
  } catch { /* Presence is advisory; an existing collection must continue unaffected. */ }
}
el("view-back").addEventListener("click", returnToPreviousView);
el("sync").addEventListener("click", async () => {
  const button = el("sync");
  if (button.disabled) return;
  button.disabled = true; button.textContent = "同步中…";
  setRefreshFeedback("正在同步本地数据…", "loading");
  try { await syncAllViews(); if (!state.pendingRefresh && state.refreshOutcome?.tone !== "error") setRefreshFeedback(`已同步本地快照 · ${state.liveRanking?.rows?.length ?? 0} 条 · ${new Date().toLocaleTimeString("zh-CN")}；无新数据时选题不变`, "success"); }
  catch (error) { setRefreshFeedback(`同步失败：${error.message}`, "error"); }
  finally { button.disabled = false; button.textContent = "同步"; }
});
el("refresh").addEventListener("click", runRealRefresh);
el("live-ranking-refresh").addEventListener("click", runRealRefresh);
el("history-refresh").addEventListener("click", runRealRefresh);
el("ranking-more").addEventListener("click", () => { state.rankingExpanded = !state.rankingExpanded; renderRanking(); });
el("live-ranking-pending").addEventListener("click", (event) => {
  if (event.target.closest("[data-pending-more]")) { state.pendingLimit = (state.pendingLimit ?? 10) + 10; renderRanking(); }
  if (event.target.closest("[data-pending-reset]")) { state.pendingLimit = 10; renderRanking(); }
});
el("today-open-ranking").addEventListener("click", () => el("opportunity-ranking").scrollIntoView({ behavior: "smooth", block: "start" }));
document.addEventListener("click", async (event) => {
  const topicButton = event.target.closest(".open-market-topic");
  if (topicButton) { state.marketDrill = { board: topicButton.dataset.board, label: topicButton.dataset.topic }; state.marketDrillExpanded = false; state.marketDrillCollapsed = false; renderMarketDrill(); el("market-drill").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const archiveButton = event.target.closest(".delete-market-archive");
  if (archiveButton) { if (!window.confirm("删除这条旧方向归档？当前方向和已收藏帖子不会删除。")) return; try { state.marketState = await api(`/api/market-state/archives/${archiveButton.dataset.index}`, { method: "DELETE" }); renderMarket(); toast("旧方向归档已删除", "success"); } catch (error) { toast(`删除失败：${error.message}`, "error"); } return; }
  const enrichButton = event.target.closest(".enrich-note");
  if (enrichButton) {
    const row = state.liveRanking?.rows?.find((item) => item.noteId === enrichButton.dataset.noteId);
    if (!row?.sourceUrl) return toast("原文地址缺失，无法补数据", "error");
    try { const result = await api("/api/notes/enrich", { method: "POST", body: JSON.stringify({ noteId: row.noteId, sourceUrl: row.sourceUrl }) }); toast(result.status === "QUEUED" ? "已加入按需补数队列；无需观看或下载视频" : "该帖已在补数队列", "success"); }
    catch (error) { toast(`补数失败：${error.message}`, "error"); }
    return;
  }
  const copyButton = event.target.closest(".copy-note-url");
  if (copyButton) { const row = state.liveRanking?.rows?.find((item) => item.noteId === copyButton.dataset.noteId) ?? state.marketState?.favorites?.find((item) => item.noteId === copyButton.dataset.noteId); if (!row?.sourceUrl) return toast("原文地址暂不可用", "error"); try { await navigator.clipboard.writeText(row.sourceUrl); toast("原文地址已复制", "success"); } catch { toast("复制失败，请打开原文后从地址栏复制", "error"); } return; }
  const historyDeleteButton = event.target.closest(".delete-history");
  if (historyDeleteButton) { await deleteViewHistory(historyDeleteButton.dataset.noteId).catch((error) => toast(`删除失败：${error.message}`, "error")); return; }
  const detailButton = event.target.closest(".open-note-detail");
  if (detailButton) { await openNoteDetail(detailButton.dataset.noteId); return; }
  const clickableRow = event.target.closest("[data-open-note-id]");
  if (clickableRow && !event.target.closest("a,button,input,select")) { await openNoteDetail(clickableRow.dataset.openNoteId); return; }
  const enhanceButton = event.target.closest(".enhance-recommendation");
  if (enhanceButton) { await enhanceRecommendation(enhanceButton.dataset.noteId); return; }
  const button = event.target.closest(".focus-live-note");
  if (!button) return;
  try {
    const row = state.liveRanking?.rows?.find((item) => item.noteId === button.dataset.noteId); const note = liveNoteFor(button.dataset.noteId);
    if (!row && !note) throw new Error("帖子不在当前数据中");
    state.marketState = await api("/api/market-state/favorites", { method: "POST", body: JSON.stringify({ noteId: button.dataset.noteId, title: row?.title ?? note?.title, sourceUrl: row?.sourceUrl ?? note?.provenance?.sourceUrls?.[0], direction: state.marketState?.direction || "全站" }) });
    renderFavorites(); toast("已收藏这条帖子", "success");
  } catch (error) { toast(`收藏失败：${error.message}`, "error"); }
});
el("favorites-copy").addEventListener("click", async () => {
  const ids = new Set([...document.querySelectorAll(".favorite-check:checked")].map((input) => input.value));
  const urls = (state.marketState?.favorites ?? []).filter((item) => ids.has(item.noteId)).map((item) => item.sourceUrl).filter(Boolean);
  if (!urls.length) return toast("请先勾选帖子", "error");
  try { await navigator.clipboard.writeText(urls.join("\n")); toast(`已复制 ${urls.length} 条地址`, "success"); } catch { toast("复制失败，请检查剪贴板权限", "error"); }
});
el("favorites-delete").addEventListener("click", async () => {
  const noteIds = [...document.querySelectorAll(".favorite-check:checked")].map((input) => input.value);
  if (!noteIds.length) return toast("请先勾选帖子", "error");
  if (!window.confirm(`删除 ${noteIds.length} 条收藏？原始采集数据不会删除。`)) return;
  try { state.marketState = await api("/api/market-state/favorites/delete", { method: "POST", body: JSON.stringify({ noteIds }) }); renderFavorites(); toast(`已删除 ${noteIds.length} 条收藏`, "success"); } catch (error) { toast(`删除失败：${error.message}`, "error"); }
});
document.querySelectorAll("[data-topic-filter]").forEach((button) => button.addEventListener("click", () => { state.topicFilter = button.dataset.topicFilter; document.querySelectorAll("[data-topic-filter]").forEach((item) => item.classList.toggle("active", item === button)); renderDatabase(); }));
let databaseSearchTimer;
["database-search", "database-tag-filter"].forEach((id) => el(id).addEventListener("input", () => { clearTimeout(databaseSearchTimer); databaseSearchTimer = setTimeout(refreshDatabaseQuery, 220); }));
let historySearchTimer;
el("history-search").addEventListener("input", () => { clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => loadViewHistory().catch((error) => toast(`历史筛选失败：${error.message}`, "error")), 220); });
["history-source", "history-selected"].forEach((id) => el(id).addEventListener("change", () => loadViewHistory().catch((error) => toast(`历史筛选失败：${error.message}`, "error"))));
el("history-clear").addEventListener("click", () => clearViewHistory().catch((error) => toast(`清空失败：${error.message}`, "error")));
el("save-database-view").addEventListener("click", async () => { const name = window.prompt("为当前检索视图命名"); if (!name?.trim()) return; const viewId = `view-${Date.now()}`; try { await api("/api/database/views", { method: "PUT", body: JSON.stringify({ viewId, name: name.trim(), query: el("database-search").value.trim(), filters: { tag: el("database-tag-filter").value.trim() || undefined } }) }); await loadCore(); el("database-view").value = viewId; toast("检索视图已保存", "success"); } catch (error) { toast(`保存视图失败：${error.message}`, "error"); } });
el("apply-database-view").addEventListener("click", async () => { const view = state.databaseViews.find((item) => item.viewId === el("database-view").value); if (!view) return toast("请先选择保存视图", "error"); el("database-search").value = view.query; el("database-tag-filter").value = view.filters?.tag ?? ""; await refreshDatabaseQuery(); });
el("restore-database").addEventListener("click", restoreDatabase);
async function controlRanking(action) { try { const run = state.runtime?.rankingRuns?.find((item) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(item.status)); if (!run) throw new Error("没有可控制的榜单运行"); await api("/api/ranking/run/control", { method: "POST", body: JSON.stringify({ action, runId: run.runId }) }); await loadCore(); toast(action === "PAUSE" ? "榜单运行已暂停" : action === "RESUME" ? "榜单运行已继续" : "榜单运行已终止", action === "CANCEL" ? "error" : "success"); } catch (error) { toast(`榜单控制失败：${error.message}`, "error"); } }
el("pause-ranking").addEventListener("click", () => controlRanking("PAUSE"));
el("resume-ranking").addEventListener("click", () => controlRanking("RESUME"));
el("cancel-ranking").addEventListener("click", () => controlRanking("CANCEL"));
el("keyword-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (el("dispatch-keyword-run").disabled) return;
  const seeds = el("seed-keywords").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!seeds.length) return toast("先写一个想研究的问题或关键词", "error");
  const target = Number(el("collection-target").value);
  if (!Number.isInteger(target) || target < 1 || target > 10000) return toast("有效入台目标请输入 1–10000 的整数", "error");
  try { saveDraft(); } catch { /* Local storage is optional; do not prevent dispatch. */ }
  const button = el("dispatch-keyword-run"); button.disabled = true; button.textContent = "正在启动…";
  try {
    const settings = { searchLimit: Number(el("collection-target").value), maxDepth: el("search-scope").value === "CORE_SEEDS_ONLY" ? 0 : Number(el("max-depth").value), maxKeywords: Number(el("max-keywords").value), maxChildrenPerKeyword: 5, notesPerKeyword: Number(el("notes-per-keyword").value), requestIntervalMs: Number(el("request-interval").value), slowNetworkMaxWaitMs: Number(el("slow-network-minutes").value) * 60000, searchScope: el("search-scope").value, collectionMethod: el("collection-method").value, autoCollectNotes: true, completeMetrics: true };
    const plan = await api("/api/keywords/plan", { method: "POST", body: JSON.stringify({ seeds: seeds.join("\n"), maxDepth: settings.maxDepth, maxKeywords: settings.maxKeywords, maxChildrenPerKeyword: settings.maxChildrenPerKeyword, noteDetailsPerKeyword: settings.notesPerKeyword, maxEstimatedNoteDetails: 1500 }) });
    const result = await api("/api/keywords/run", { method: "POST", body: JSON.stringify({ plan, settings }) });
    const run = result.run;
    try {
      const history = readPlanHistory(); history.unshift({ createdAt: new Date().toISOString(), seeds, maxDepth: settings.maxDepth, maxKeywords: settings.maxKeywords, notesPerKeyword: settings.notesPerKeyword, runId: run.runId });
      localStorage.setItem(planHistoryKey, JSON.stringify(history.slice(0, 20))); renderPlanHistory();
    } catch { /* An accepted server run must not be reported as a failed start. */ }
    el("collection-output").textContent = JSON.stringify(run, null, 2);
    await loadCore();
    toast(`已向现有小红书标签页派发 ${result.dispatchedTasks} 个扩展采集任务`, "success");
  } catch (error) { el("collection-output").textContent = `启动失败：${error.message}`; toast(`启动失败：${error.message}`, "error"); }
  finally { button.disabled = false; button.textContent = "开始本轮采集"; }
});
el("browser-task-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/browser-bridge/tasks", { method: "POST", body: JSON.stringify({ tasks: [{ sourceId: el("browser-task-source").value.trim(), targetUrl: el("browser-task-url").value.trim(), expectedPageType: el("browser-task-type").value, priority: Number(el("browser-task-priority").value), maxAttempts: 3 }] }) }); el("browser-task-url").value = ""; await loadCore(); toast("浏览器采集任务已入队", "success"); } catch (error) { toast(`入队失败：${error.message}`, "error"); } });
el("human-comparison-form").addEventListener("submit", submitHumanComparison);
el("refresh-browser-queue").addEventListener("click", () => loadCore());
async function pollCollectionJob() {
  clearTimeout(state.collectionPoll);
  try {
    const job = await api("/api/collection/job");
    state.runtime.collectionJob = job.status === "IDLE" ? null : job; renderCollection();
    el("collection-output").textContent = JSON.stringify(job, null, 2);
    if (["QUEUED", "RUNNING", "PAUSED"].includes(job.status)) state.collectionPoll = setTimeout(pollCollectionJob, 500);
    else { await loadCore(); toast(job.status === "SUCCEEDED" ? "离线采集闭环执行完成" : `采集任务已结束：${job.status}`, job.status === "SUCCEEDED" ? "success" : "error"); }
  } catch (error) { toast(`运行状态读取失败：${error.message}`, "error"); }
}
el("run-fixture").addEventListener("click", async () => { el("collection-output").textContent = "正在启动离线采集、详情/评论完整度核验和分析链..."; try { const job = await api("/api/collection/run", { method: "POST", body: JSON.stringify({ mode: "OFFLINE_FIXTURE" }) }); state.runtime.collectionJob = job; renderCollection(); pollCollectionJob(); } catch (error) { el("collection-output").textContent = `运行失败：${error.message}`; toast(`运行失败：${error.message}`, "error"); } });
async function controlCollection(action) { try { const progress = state.runtime?.collectionProgress; const legacyRun = state.runtime?.researchRuns?.find((run) => ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"].includes(run.status)); const run = progress?.active ? progress.run : legacyRun; if (!run) throw new Error("当前没有可控制的采集任务"); const path = progress?.active ? progress.runKind === "RANKING" ? "/api/ranking/run/control" : "/api/keywords/run/control" : "/api/research-runs/control"; await api(path, { method: "POST", body: JSON.stringify({ action, runId: run.runId }) }); await syncAllViews(); toast(action === "PAUSE" ? "会在当前任务收尾后暂停" : action === "RESUME" ? "采集已继续" : "会在当前任务收尾后停止", action === "CANCEL" ? "error" : "success"); } catch (error) { toast(`控制失败：${error.message}`, "error"); } }
el("pause-collection").addEventListener("click", () => controlCollection("PAUSE"));
el("resume-collection").addEventListener("click", () => controlCollection("RESUME"));
el("cancel-collection").addEventListener("click", () => controlCollection("CANCEL"));
el("collect-notes").addEventListener("click", async () => {
  const run = state.runtime?.keywordRuns?.find((item) => ["QUEUED", "RUNNING", "PAUSED"].includes(item.status));
  if (!run) return toast("当前没有可补采笔记的关键词任务", "error");
  try {
    await api("/api/keywords/run/control", { method: "POST", body: JSON.stringify({ action: "ENRICH", runId: run.runId }) });
    el("auto-collect-notes").checked = true; saveDraft();
    await loadRuntimeSummary();
    toast("已开启：剩余搜索词会继续补采笔记详情", "success");
  } catch (error) { toast(`开启采笔记失败：${error.message}`, "error"); }
});
el("collection-card-close").addEventListener("click", () => {
  state.collectionCardExpanded = false;
  renderCollection();
  el("collection-card-expand").focus();
});
function expandCollectionCard() {
  if (!state.runtime?.collectionProgress?.run && !(state.runtime?.keywordRuns ?? []).length && !(state.runtime?.rankingRuns ?? []).length) return;
  state.collectionCardExpanded = true;
  renderCollection();
  el("collection-card-close").focus();
}
el("collection-card-expand").addEventListener("click", expandCollectionCard);
el("collection-inline-expand").addEventListener("click", () => { switchView("overview", { restoreScroll: false }); el("opportunity-ranking").scrollIntoView({ behavior: "smooth", block: "start" }); });
const workComparison = mountWorkComparison(el("work-comparison"), {
  storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
  onExport: payload => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "我的作品对照.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
});
const researchDrafts = new Map();
let researchExamples = [];
function renderResearchWorkspace() {
  const purpose = el("research-purpose").value;
  const scope = el("research-scope").value;
  const market = state.marketState ?? {};
  workComparison.setContext({ direction: market.direction ?? "", scope, purpose });
  const result = buildResearchWorkspace(state.liveRanking?.rows ?? [], { purpose, scope, direction: market.direction ?? "", preciseTerms: market.preciseTerms ?? [], windowHours: Number(el("research-window").value) });
  el("research-evidence-summary").textContent = `${scope === "all" ? "全站已采样本" : `当前方向：${market.direction || "尚未设置"}`} · ${result.coverage.total} 条参考 · 三项齐全 ${result.coverage.complete} 条 · 本指标可比较 ${result.comparable} 条`;
  el("research-boundary").textContent = result.boundary;
  el("research-question").textContent = result.intent.question;
  el("research-experiment").textContent = result.intent.experiment;
  el("research-examples").innerHTML = result.examples.length ? result.examples.map((row, index) => `<article class="research-example"><span class="rank-number">${index + 1}</span><div><strong>${esc(row.title)}</strong><p>赞 ${formatNumber(row.likes)} · 藏 ${formatNumber(row.collects)} · 转 ${formatNumber(row.shares)}</p><small>${row.facts.complete ? "三项有数据；仍需核对观察时间与原文" : `待补证：${esc(row.facts.missing.join("、"))}`}</small></div><button class="secondary open-note-detail" data-note-id="${esc(row.noteId)}" type="button">查看证据</button></article>`).join("") : `<p class="empty-state">暂无可比较的样本。先按研究方向采集；缺失指标不会按零补齐。</p>`;
  researchExamples = result.examples;
  el("research-examples").querySelectorAll(".research-example").forEach((article, index) => {
    const actions = document.createElement("div"); actions.className = "research-example-actions";
    actions.append(article.querySelector("button"));
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary";
    button.dataset.referenceIndex = String(index); button.textContent = "记为参考";
    actions.append(button); article.append(actions);
    const row = result.examples[index];
    const analyze = document.createElement("button"); analyze.type = "button"; analyze.className = "secondary enhance-recommendation";
    analyze.dataset.noteId = row.noteId;
    analyze.disabled = Boolean(state.modelAnalysisPending) || state.providers?.apiEnabled !== true;
    analyze.textContent = state.modelAnalysisPending === row.noteId ? "正在分析…" : "模型分析";
    analyze.title = "在模型连接中开启 API 后，逐次确认调用；缺失数据不会补成事实";
    actions.append(analyze);
    const insight = state.modelInsight;
    if (insight?.noteId === row.noteId) {
      const panel = document.createElement("div"); panel.className = "research-model-insight";
      panel.innerHTML = `<strong>可尝试的角度：${esc(insight.recommendedAngle)}</strong><p>${esc(insight.whyItWorks)}</p><ol>${insight.executionSteps.map(step => `<li>${esc(step)}</li>`).join("")}</ol><p>证据限制：${insight.risks.map(esc).join("；") || "模型未列出；仍需人工核对"}</p><small>模型建议，不是效果保证 · ${esc(insight.modelId)}</small>`;
      article.append(panel);
    }
  });
  const key = `xhs-research-review-v1:${market.direction || "UNSET"}:${scope}:${purpose}`;
  if (el("research-review").dataset.key !== key) {
    const previous = el("research-review").dataset.key;
    if (previous) researchDrafts.set(previous, { value: el("research-review").value, status: el("research-review-status").textContent });
    el("research-review").dataset.key = key;
    const cached = researchDrafts.get(key);
    if (cached) {
      el("research-review").value = cached.value;
      el("research-review-status").textContent = cached.status;
    } else {
      try {
        el("research-review").value = localStorage.getItem(key) ?? "";
        el("research-review-status").textContent = "按方向与研究用途分别保存；仅保存在此浏览器，不自动修改评分。";
      } catch {
        el("research-review").value = "";
        el("research-review-status").textContent = "无法读取本地复盘；旧存储未清除，请先检查浏览器存储。";
      }
    }
  }
}
for (const id of ["research-purpose", "research-scope", "research-window"]) el(id).addEventListener("change", renderResearchWorkspace);
el("research-review").addEventListener("input", () => {
  try {
    localStorage.setItem(el("research-review").dataset.key, el("research-review").value);
    el("research-review-status").textContent = "复盘已保存到此浏览器。";
  } catch { el("research-review-status").textContent = "保存失败，请复制保留这段复盘；当前输入仍在。"; }
});
el("research-examples").addEventListener("click", event => {
  const button = event.target.closest("[data-reference-index]");
  if (!button) return;
  const row = researchExamples[Number(button.dataset.referenceIndex)];
  if (!row) return;
  const excerpt = referenceExcerpt(row);
  const input = el("research-review");
  if (!input.value.includes(excerpt)) {
    input.value = [input.value.trimEnd(), excerpt].filter(Boolean).join("\n\n");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.focus();
});
el("research-review-export").addEventListener("click", () => {
  try {
    const payload = { schemaVersion: 1, direction: state.marketState?.direction ?? "", scope: el("research-scope").value, purpose: el("research-purpose").value, review: el("research-review").value, exportedAt: new Date().toISOString(), source: "USER_NOTES_WITH_OBSERVED_REFERENCE_FIELDS", boundary: "参考字段不代表完整原文或采纳；手动复盘未经平台验证。" };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "参考与复盘.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    el("research-review-status").textContent = "已发起复盘下载，请确认保存结果；这不代表浏览器自动保存成功。";
  } catch { el("research-review-status").textContent = "导出失败，文字仍在；请复制备份。"; }
});
el("collection-use-direction").addEventListener("click", () => {
  const direction = String(state.marketState?.direction ?? "").trim();
  const feedback = el("collection-direction-feedback");
  if (!direction) { feedback.textContent = "还没有已保存方向；可直接输入临时关键词，或先在方向榜单保存方向。"; return; }
  if (el("seed-keywords").value.trim()) { feedback.textContent = "已有输入已保留。如需替换，请先清空关键词，再填入已保存方向。"; return; }
  el("seed-keywords").value = [...new Set([direction, ...(state.marketState?.preciseTerms ?? [])].map(String).map(value => value.trim()).filter(Boolean))].join("\n");
  try { saveDraft(); } catch { /* Keep the visible draft when storage is unavailable. */ }
  feedback.textContent = "已填入保存的方向和关键词。尚未开始采集，也未修改方向设置。";
  el("seed-keywords").focus();
});
document.querySelectorAll(".ranking-shortcuts a").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); document.querySelector(link.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
el("keyword-file").addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const values = parseKeywordTaskFile(file.name, await file.text()); el("seed-keywords").value = values.join("\n"); el("keyword-file-status").textContent = `已导入 ${file.name}：${values.length} 个去重种子词`; saveDraft(); toast("任务文件已导入", "success"); } catch (error) { el("keyword-file-status").textContent = `导入失败：${error.message}`; toast(`导入失败：${error.message}`, "error"); } });
el("reuse-plan").addEventListener("click", () => { const selected = el("plan-history").value; if (selected === "") return toast("请先选择历史任务", "error"); const item = readPlanHistory()[Number(selected)]; if (!item) return toast("历史任务不存在", "error"); el("seed-keywords").value = item.seeds.join("\n"); el("max-depth").value = item.maxDepth; el("max-keywords").value = item.maxKeywords; el("notes-per-keyword").value = item.notesPerKeyword; saveDraft(); toast("历史任务已载入", "success"); });
["seed-keywords", "collection-target", "max-depth", "max-keywords", "notes-per-keyword", "collection-comment-limit", "request-interval", "slow-network-minutes", "search-scope", "collection-method", "auto-collect-notes"].forEach((id) => el(id).addEventListener("input", saveDraft));
el("matrix-form").addEventListener("submit", async (event) => { event.preventDefault(); const account = { accountId: el("matrix-id").value.trim(), label: el("matrix-label").value.trim(), profileHint: el("matrix-hint").value.trim(), enabled: el("matrix-enabled").checked }; if (!account.accountId || !account.label) return toast("账号标识和显示名称不能为空", "error"); if ((state.connections?.matrixAccounts ?? []).some((item) => item.accountId === account.accountId)) return toast("账号标识不能重复", "error"); await saveMatrixAccounts([...(state.connections?.matrixAccounts ?? []), account]); el("matrix-form").reset(); el("matrix-enabled").checked = true; });
el("feishu-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await api("/api/connections/feishu", { method: "PUT", body: JSON.stringify({ webhookEnv: el("feishu-env").value.trim(), enabled: el("feishu-enabled").checked }) }); await loadConnections(); toast("飞书同步配置已保存", "success"); } catch (error) { toast(`保存失败：${error.message}`, "error"); } });
el("feishu-sync").addEventListener("click", async () => { if (!window.confirm("这会向已配置的飞书 Webhook 发出一次真实联网请求。是否继续？")) return; try { const receipt = await api("/api/connections/feishu/sync", { method: "POST", body: JSON.stringify({ confirmExternalCall: true }) }); toast(`同步成功：${receipt.candidateCount} 条候选`, "success"); } catch (error) { toast(`同步失败：${error.message}`, "error"); } });
el("save-routes").addEventListener("click", async () => { const routes = [...document.querySelectorAll(".route-row")].map((row) => ({ task: row.dataset.task, providerId: row.querySelector("[data-route-provider]").value, modelId: row.querySelector("[data-route-model]").value, fallbackProviderIds: [] })); try { await api("/api/model-routes", { method: "PUT", body: JSON.stringify({ routes }) }); toast("模型任务路由已保存", "success"); await loadProviders(); } catch (error) { toast(`保存失败：${error.message}`, "error"); } });

el("market-control-host").append(el("collection-live-card"));
restoreDraft(); renderPlanHistory(); switchView(location.hash.slice(1), { updateHash: false, recordHistory: false });
setInterval(() => { if (["overview", "collection", "database", "detail", "history"].includes(state.view)) pollRuntimeStatus(); }, 2000);
setTimeout(reportWorkbenchPresence, 1500);
setInterval(reportWorkbenchPresence, 30_000);
