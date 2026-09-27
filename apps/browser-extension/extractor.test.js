import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./extractor.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);

test("classifies supported visible page URLs", () => {
  assert.equal(context.XhsVisibleExtractor.pageType("https://www.xiaohongshu.com/search_result?keyword=咖啡"), "SEARCH");
  assert.equal(context.XhsVisibleExtractor.pageType("https://www.xiaohongshu.com/explore/abc123"), "NOTE_DETAIL");
});

test("classifies a visible detail modal on the search route as note detail", () => {
  assert.equal(context.XhsVisibleExtractor.pageType("https://www.xiaohongshu.com/search_result?keyword=咖啡", true), "NOTE_DETAIL");
});

test("keeps the visible detail overlay as capture scope after the site rewrites the URL to explore", () => {
  const overlay = {
    textContent: "真实详情内容".repeat(20),
    getBoundingClientRect: () => ({ width: 800, height: 900 }),
    querySelector: (selector) => selector.includes("note-content") ? { textContent: "真实详情内容" } : null,
  };
  const root = {
    querySelectorAll: (selector) => selector === "#noteContainer" ? [overlay] : [],
  };
  assert.equal(
    context.XhsVisibleExtractor.detailScopeForCapture("https://www.xiaohongshu.com/explore/note-1", root),
    overlay,
  );
});

test("detail title avoids a generic background search-card title", () => {
  const backgroundTitle = { textContent: "背后的搜索卡片标题" };
  const scope = {
    querySelector: (selector) => selector === ".title" ? backgroundTitle : null,
  };
  assert.equal(
    context.XhsVisibleExtractor.extractDetailTitle(scope, "真实详情标题 - 小红书"),
    "真实详情标题",
  );
});

test("fails closed on an unsupported page URL", () => {
  assert.equal(context.XhsVisibleExtractor.pageType("https://www.xiaohongshu.com/user/profile/abc"), "UNKNOWN");
});

test("reads a search keyword from the visible search input after URL normalization", () => {
  const root = { querySelector: (selector) => selector === "input.search-input" ? { value: "  小红书  " } : null };
  assert.equal(context.XhsVisibleExtractor.searchKeyword("https://www.xiaohongshu.com/search_result/", root), "小红书");
});

test("URL keyword remains authoritative when present", () => {
  const root = { querySelector: () => ({ value: "咖啡" }) };
  assert.equal(context.XhsVisibleExtractor.searchKeyword("https://www.xiaohongshu.com/search_result?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6", root), "小红书");
});

test("visible metric parser treats Xiaohongshu's bare like label as zero", () => {
  assert.equal(context.XhsVisibleExtractor.parseVisibleMetric("赞", ["赞"]), 0);
  assert.equal(context.XhsVisibleExtractor.parseVisibleMetric("1.2万", ["赞"]), 12000);
  assert.equal(context.XhsVisibleExtractor.parseVisibleMetric("未知", ["赞"]), null);
});

test("separates all observed comments from retained high-value comments", () => {
  const comments = [
    { ordinal: 1, author: "甲", text: "不错", likes: 0 },
    { ordinal: 2, author: "乙", text: "这个怎么操作？有教程吗", likes: 1 },
    { ordinal: 3, author: "丙", text: "亲测用了三天，最大问题是太贵", likes: 12 },
  ];
  const retained = context.XhsVisibleExtractor.selectUsefulComments(comments);
  assert.equal(comments.length, 3);
  assert.equal(retained.length, 2);
  assert.equal(retained.some((item) => item.text === "不错"), false);
  assert.equal(retained.some((item) => item.selectionReasons.includes("EXPLICIT_DEMAND_OR_ACTION_INTENT")), true);
  assert.equal(retained.some((item) => item.selectionReasons.includes("OBJECTION_OR_RISK_SIGNAL")), true);
});

test("accumulates virtualized comments by stable identity before filtering", () => {
  const merged = context.XhsVisibleExtractor.mergeObservedComments(
    [{ platformCommentId: "c1", author: "甲", text: "怎么操作？" }],
    [{ platformCommentId: "c1", author: "甲", text: "怎么操作？", likes: 3 }, { platformCommentId: "c2", author: "乙", text: "支持" }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].likes, 3);
});

test("search card extraction requires a real explore link and prefers the exact author name", () => {
  const values = new Map([
    ["a[href*='/explore/']", { href: "https://www.xiaohongshu.com/explore/note-1?xsec_token=token" }],
    [".title", { textContent: "真实标题" }],
    [".author .name", { textContent: "作者本人" }],
    [".author", { textContent: "作者本人 昨天 16:16" }],
    [".like-wrapper .count", { textContent: "赞" }],
    [".collect-wrapper .count", { textContent: "收藏 12" }],
    [".share-wrapper .count", { textContent: "转发 3" }],
  ]);
  const node = { textContent: "真实标题 作者本人 昨天 16:16 赞", querySelector: (selector) => values.get(selector) ?? null, querySelectorAll: (selector) => values.has(selector) ? [{ ...values.get(selector), closest: () => null }] : [] };
  const card = context.XhsVisibleExtractor.buildSearchCard(node, 1);
  assert.equal(card.noteId, "note-1");
  assert.equal(card.authorName, "作者本人");
  assert.equal(card.likes, 0);
  assert.equal(card.collects, 12);
  assert.equal(card.shares, 3);
  assert.equal(card.ordinal, 1);
  assert.equal(card.mediaType, "UNKNOWN");
});

test("marks a video search card from its visible play marker without opening it", () => {
  const values = new Map([
    ["a[href*='/explore/']", { href: "https://www.xiaohongshu.com/explore/video-1" }],
    [".title", { textContent: "视频标题" }],
    ["video, [data-type='video'], [data-note-type='video'], [aria-label*='视频'], [title*='视频'], [class*='play-icon'], [class*='video-icon']", { className: "play-icon" }],
  ]);
  const node = { textContent: "视频标题 作者 01:20", querySelector: (selector) => values.get(selector) ?? null, querySelectorAll: () => [] };
  const card = context.XhsVisibleExtractor.buildSearchCard(node, 1);
  assert.equal(card.mediaType, "VIDEO");
});

test("search recommendation blocks without an explore link are not cards", () => {
  const node = { textContent: "大家都在搜", querySelector: () => null, getAttribute: () => "recommendation-id" };
  assert.equal(context.XhsVisibleExtractor.buildSearchCard(node, 1), null);
});

test("recovers search cards from real explore anchors when note-item classes change", () => {
  const anchor = {
    href: "https://www.xiaohongshu.com/explore/note-fallback",
    getAttribute: (name) => name === "href" ? "/explore/note-fallback" : null,
    closest: () => null,
  };
  const card = {
    textContent: "新版卡片标题 新作者 88",
    parentElement: null,
    querySelector: (selector) => selector === "a[href*='/explore/']" ? anchor : selector.includes("title") ? { textContent: "新版卡片标题" } : null,
    querySelectorAll: (selector) => selector === "a[href*='/explore/']" ? [anchor] : [],
  };
  anchor.parentElement = card;
  const root = {
    querySelectorAll: (selector) => selector === "a[href*='/explore/']" ? [anchor] : [],
  };
  const cards = context.XhsVisibleExtractor.searchCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].noteId, "note-fallback");
  assert.equal(cards[0].title, "新版卡片标题");
});

test("accumulates virtualized search pages by note id instead of trusting one visible screen", () => {
  const first = [{ noteId: "n1", ordinal: 1, title: "第一页" }, { noteId: "n2", ordinal: 2, title: "旧标题" }];
  const second = [{ noteId: "n2", ordinal: 1, title: "更新标题" }, { noteId: "n3", ordinal: 2, title: "第二页" }];
  const merged = context.XhsVisibleExtractor.mergeSearchCards(first, second);
  assert.deepEqual(Array.from(merged, (card) => card.noteId), ["n1", "n2", "n3"]);
  assert.equal(merged[1].title, "更新标题");
  assert.deepEqual(Array.from(merged, (card) => card.ordinal), [1, 2, 3]);
});

test("keeps up to 1500 deduplicated search candidates by default", () => {
  const cards = Array.from({ length: 1600 }, (_, index) => ({ noteId: `n${index}`, ordinal: index + 1, title: `标题${index}` }));
  const merged = context.XhsVisibleExtractor.mergeSearchCards([], cards);
  assert.equal(merged.length, 1500);
  assert.equal(merged[1499].noteId, "n1499");
});

test("honors a user-selected target above the old 1500 candidate ceiling", () => {
  const cards = Array.from({ length: 3200 }, (_, index) => ({ noteId: `n${index}`, ordinal: index + 1, title: `标题${index}` }));
  const merged = context.XhsVisibleExtractor.mergeSearchCards([], cards, 3000);
  assert.equal(merged.length, 3000);
  assert.equal(merged[2999].noteId, "n2999");
});

test("advances the existing search scroller so lazy-loaded results can be accumulated", () => {
  const scroller = {
    scrollHeight: 3200, clientHeight: 600, scrollTop: 0,
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const root = { scrollingElement: scroller, documentElement: scroller, querySelectorAll: () => [] };
  const result = context.XhsVisibleExtractor.advanceSearchResults(root);
  assert.equal(result.advanced, true);
  assert.equal(scroller.scrollTop, 1080);
  assert.equal(result.maximum, 2600);
});

test("opens the exact search-card anchor without rewriting the site's target", () => {
  let clicked = 0;
  const attributes = new Map([["href", "/explore/note-1?xsec_token=token"], ["target", "_blank"]]);
  const anchor = {
    href: "https://www.xiaohongshu.com/explore/note-1?xsec_token=token",
    isConnected: true,
    click: () => { clicked += 1; },
    scrollIntoView: () => {},
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const root = { querySelectorAll: () => [anchor] };
  const result = context.XhsVisibleExtractor.openSearchCard("note-1", root);
  assert.equal(result.opened, true);
  assert.equal(result.noteId, "note-1");
  assert.equal(clicked, 1);
  assert.equal(result.strategy, "VISIBLE_ANCHOR");
  assert.equal(attributes.get("target"), "_blank");
});

test("opens a zero-sized overlay through the visible card surface instead of naked-link navigation", () => {
  let anchorClicked = 0;
  let coverClicked = 0;
  let scrolled = 0;
  const attributes = new Map([["href", "/explore/note-overlay"]]);
  const cover = {
    getBoundingClientRect: () => ({ width: 300, height: 400 }),
    click: () => { coverClicked += 1; },
  };
  const card = {
    getBoundingClientRect: () => ({ width: 320, height: 460 }),
    scrollIntoView: () => { scrolled += 1; },
    querySelector: (selector) => selector.includes("cover") ? cover : null,
  };
  const anchor = {
    href: "https://www.xiaohongshu.com/explore/note-overlay",
    isConnected: true,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    closest: () => card,
    click: () => { anchorClicked += 1; },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const root = { querySelectorAll: () => [anchor] };
  const result = context.XhsVisibleExtractor.openSearchCard("note-overlay", root);
  assert.equal(result.opened, true);
  assert.equal(result.strategy, "VISIBLE_CARD_SURFACE");
  assert.equal(anchorClicked, 0);
  assert.equal(coverClicked, 1);
  assert.equal(scrolled, 1);
  assert.equal(attributes.has("target"), false);
});

test("comment traversal stays incomplete while replies or root pages remain", () => {
  const state = context.XhsVisibleExtractor.classifyCommentTraversal(["展开 6 条回复", "加载更多评论"], { scrollHeight: 2000, scrollTop: 500, clientHeight: 500 }, 12);
  assert.equal(state.expandableReplyCount, 1);
  assert.equal(state.hasMoreRootComments, true);
  assert.equal(state.bottomReached, false);
  assert.equal(state.complete, false);
});

test("comment traversal closes only at the bottom with no disclosure controls", () => {
  const state = context.XhsVisibleExtractor.classifyCommentTraversal([], { scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }, 18);
  assert.equal(state.complete, true);
  assert.equal(state.visibleCommentCount, 18);
});

test("comment traversal cannot close when no comment section was observed", () => {
  const state = context.XhsVisibleExtractor.classifyCommentTraversal([], { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }, 0, false);
  assert.equal(state.sectionObserved, false);
  assert.equal(state.bottomReached, false);
  assert.equal(state.complete, false);
});

test("parses a visible declared comment total including a real empty state", () => {
  assert.equal(context.XhsVisibleExtractor.parseDeclaredCommentTotal("评论 共 18 条评论"), 18);
  assert.equal(context.XhsVisibleExtractor.parseDeclaredCommentTotal("还没有评论，快来抢沙发"), 0);
  assert.equal(context.XhsVisibleExtractor.parseDeclaredCommentTotal("展开 3 条回复"), null);
});
