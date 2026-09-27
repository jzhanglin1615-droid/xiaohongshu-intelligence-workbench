import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserSnapshotFields } from "./browser-field-validation.js";

const options = { receiptId: "receipt-1", fingerprint: "a".repeat(64), createdAt: "2026-09-25T00:00:00.000Z" };

test("complete search coverage becomes ready for human comparison without claiming validation", () => {
  const result = validateBrowserSnapshotFields({
    status: "VISIBLE", pageType: "SEARCH", sourceUrl: "https://www.xiaohongshu.com/search_result?keyword=咖啡&xsec_token=secret", capturedAt: options.createdAt, keyword: "咖啡",
    cards: [{ ordinal: 1, noteId: "note-1", sourceUrl: "https://www.xiaohongshu.com/explore/note-1?token=secret", title: "标题", authorName: "作者", likes: 12 }],
  }, options);
  assert.equal(result.machineCoverageStatus, "COMPLETE");
  assert.equal(result.overallStatus, "READY_FOR_HUMAN_COMPARE");
  assert.equal(result.humanComparisonStatus, "NOT_STARTED");
  assert.equal(result.sourcePath, "https://www.xiaohongshu.com/search_result");
  assert.equal(result.sha256.length, 64);
});

test("search cards without stable identities are blocked", () => {
  const result = validateBrowserSnapshotFields({ status: "VISIBLE", pageType: "SEARCH", sourceUrl: "https://www.xiaohongshu.com/search_result", keyword: "咖啡", cards: [{ ordinal: 1, title: "只有标题" }] }, options);
  assert.equal(result.machineCoverageStatus, "BLOCKED");
  assert.ok(result.gaps.includes("SEARCH_CARD_NOTE_ID_GAP"));
  assert.ok(result.gaps.includes("SEARCH_CARD_URL_GAP"));
});

test("detail coverage preserves comment and reply identity gaps", () => {
  const result = validateBrowserSnapshotFields({
    status: "VISIBLE", pageType: "NOTE_DETAIL", sourceUrl: "https://www.xiaohongshu.com/explore/note-1", noteId: "note-1", noteTitle: "标题", authorName: "作者", body: "正文",
    metrics: { likes: 10, collects: 2, comments: 1 }, assets: [], visibleComments: [{ ordinal: 1, author: "评论者", text: "内容" }], commentTraversal: { complete: true, visibleCommentCount: 1 },
  }, options);
  assert.equal(result.machineCoverageStatus, "BLOCKED");
  assert.ok(result.gaps.includes("COMMENT_PLATFORM_ID_GAP"));
  assert.ok(result.gaps.includes("COMMENT_PARENT_REPLY_RELATION_GAP"));
  assert.equal(result.humanComparisonStatus, "NOT_STARTED");
});

test("human verification pages fail closed", () => {
  const result = validateBrowserSnapshotFields({ status: "HUMAN_REQUIRED", pageType: "NOTE_DETAIL", sourceUrl: "https://www.xiaohongshu.com/explore/note-1" }, options);
  assert.equal(result.overallStatus, "BLOCKED");
  assert.ok(result.gaps.includes("HUMAN_VERIFICATION_REQUIRED"));
});

test("contract fixtures can never masquerade as real-platform field validation", () => {
  const result = validateBrowserSnapshotFields({
    testFixture: true, status: "VISIBLE", pageType: "SEARCH", sourceUrl: "https://www.xiaohongshu.com/search_result", keyword: "夹具",
    cards: [{ ordinal: 1, noteId: "fixture-1", sourceUrl: "https://www.xiaohongshu.com/explore/fixture-1", title: "标题", authorName: "作者", likes: 1 }],
  }, options);
  assert.equal(result.evidenceClass, "CONTRACT_TEST");
  assert.equal(result.overallStatus, "CONTRACT_ONLY");
  assert.equal(result.humanComparisonStatus, "NOT_APPLICABLE");
});
