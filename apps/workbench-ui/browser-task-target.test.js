import assert from "node:assert/strict";
import test from "node:test";
import { matchesBrowserTaskTarget } from "./browser-task-target.js";

test("accepts the real redirected search URL with a trailing slash and added type parameter", () => {
  const task = {
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6&source=web_explore_feed",
    expectedPageType: "SEARCH",
    context: { keyword: "小红书" },
  };
  const actual = "https://www.xiaohongshu.com/search_result/?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6&source=web_explore_feed&type=51";
  assert.equal(matchesBrowserTaskTarget(task, actual, { pageType: "SEARCH", keyword: "小红书", cards: [{ noteId: "n1" }] }), true);
});

test("rejects a redirected search page for a different keyword", () => {
  const task = { targetUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1", expectedPageType: "SEARCH", context: { keyword: "咖啡" } };
  assert.equal(matchesBrowserTaskTarget(task, "https://www.xiaohongshu.com/search_result/?keyword=%E9%9C%B2%E8%90%A5", { pageType: "SEARCH", keyword: "露营", cards: [{ noteId: "n1" }] }), false);
});

test("accepts harmless detail query parameters but never a different note", () => {
  const task = { targetUrl: "https://www.xiaohongshu.com/explore/note-1", expectedPageType: "NOTE_DETAIL" };
  assert.equal(matchesBrowserTaskTarget(task, "https://www.xiaohongshu.com/explore/note-1?xsec_token=token", { pageType: "NOTE_DETAIL", noteId: "note-1" }), true);
  assert.equal(matchesBrowserTaskTarget(task, "https://www.xiaohongshu.com/explore/note-2?xsec_token=token", { pageType: "NOTE_DETAIL", noteId: "note-2" }), false);
});

test("accepts a search-route detail modal only when the observed note identity matches", () => {
  const task = {
    targetUrl: "https://www.xiaohongshu.com/explore/note-1",
    expectedPageType: "NOTE_DETAIL",
    context: {
      noteId: "note-1",
      navigationMode: "CLICK_SEARCH_CARD",
      parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=x",
    },
  };
  const modalUrl = "https://www.xiaohongshu.com/search_result?keyword=x";
  assert.equal(matchesBrowserTaskTarget(task, modalUrl, { pageType: "NOTE_DETAIL", noteId: "note-1" }), true);
  assert.equal(matchesBrowserTaskTarget(task, modalUrl, { pageType: "NOTE_DETAIL", noteId: "note-2" }), false);
});

test("rejects a different origin or page type", () => {
  const task = { targetUrl: "https://www.xiaohongshu.com/search_result?keyword=x", expectedPageType: "SEARCH", context: { keyword: "x" } };
  assert.equal(matchesBrowserTaskTarget(task, "https://example.com/search_result?keyword=x", { pageType: "SEARCH", keyword: "x", cards: [{ noteId: "n1" }] }), false);
  assert.equal(matchesBrowserTaskTarget(task, "https://www.xiaohongshu.com/search_result?keyword=x&type=51", { pageType: "NOTE_DETAIL", keyword: "x" }), false);
});
