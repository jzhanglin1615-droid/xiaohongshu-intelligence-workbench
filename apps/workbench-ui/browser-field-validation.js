import { createHash } from "node:crypto";

const text = (value) => typeof value === "string" ? value.trim() : "";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const metric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function safeSourcePath(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && /(^|\.)xiaohongshu\.com$/i.test(url.hostname) ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

function field(key, section, required, present, observedCount = null, expectedCount = null, gapCode = null, note = null) {
  return { key, section, required, present: Boolean(present), observedCount, expectedCount, gapCode: present ? null : gapCode, note };
}

function searchFields(snapshot) {
  const cards = list(snapshot.cards).map(record);
  const count = cards.length;
  const countWith = (predicate) => cards.filter(predicate).length;
  return [
    field("search.keyword", "SEARCH", true, Boolean(text(snapshot.keyword)), text(snapshot.keyword) ? 1 : 0, 1, "SEARCH_KEYWORD_MISSING"),
    field("search.cards", "SEARCH", true, count > 0, count, null, "SEARCH_CARDS_MISSING"),
    field("card.noteId", "CARD", true, count > 0 && countWith((item) => Boolean(text(item.noteId))) === count, countWith((item) => Boolean(text(item.noteId))), count, "SEARCH_CARD_NOTE_ID_GAP"),
    field("card.sourceUrl", "CARD", true, count > 0 && countWith((item) => Boolean(text(item.sourceUrl))) === count, countWith((item) => Boolean(text(item.sourceUrl))), count, "SEARCH_CARD_URL_GAP"),
    field("card.ordinal", "CARD", true, count > 0 && countWith((item) => Number.isInteger(item.ordinal) && item.ordinal > 0) === count, countWith((item) => Number.isInteger(item.ordinal) && item.ordinal > 0), count, "SEARCH_CARD_ORDINAL_GAP"),
    field("card.title", "CARD", false, count > 0 && countWith((item) => Boolean(text(item.title))) === count, countWith((item) => Boolean(text(item.title))), count, "SEARCH_CARD_TITLE_GAP"),
    field("card.authorName", "CARD", false, count > 0 && countWith((item) => Boolean(text(item.authorName))) === count, countWith((item) => Boolean(text(item.authorName))), count, "SEARCH_CARD_AUTHOR_GAP"),
    field("card.likes", "CARD", false, count > 0 && countWith((item) => metric(item.likes)) === count, countWith((item) => metric(item.likes)), count, "SEARCH_CARD_LIKES_GAP"),
  ];
}

function detailFields(snapshot) {
  const metrics = record(snapshot.metrics);
  const comments = list(snapshot.visibleComments).map(record);
  const traversal = record(snapshot.commentTraversal);
  const commentCount = comments.length;
  const fetchedCommentCount = Number.isInteger(traversal.fetchedTotal) ? traversal.fetchedTotal : commentCount;
  const countWith = (predicate) => comments.filter(predicate).length;
  const commentsNeedIdentity = commentCount > 0;
  return [
    field("detail.noteId", "DETAIL", true, Boolean(text(snapshot.noteId)), text(snapshot.noteId) ? 1 : 0, 1, "DETAIL_NOTE_ID_MISSING"),
    field("detail.title", "DETAIL", true, Boolean(text(snapshot.noteTitle)), text(snapshot.noteTitle) ? 1 : 0, 1, "DETAIL_TITLE_MISSING"),
    field("detail.authorName", "DETAIL", true, Boolean(text(snapshot.authorName)), text(snapshot.authorName) ? 1 : 0, 1, "DETAIL_AUTHOR_MISSING"),
    field("detail.body", "DETAIL", true, Boolean(text(snapshot.body)), text(snapshot.body) ? 1 : 0, 1, "DETAIL_BODY_MISSING"),
    field("metrics.likes", "METRICS", false, metric(metrics.likes), metric(metrics.likes) ? 1 : 0, 1, "DETAIL_LIKES_MISSING"),
    field("metrics.collects", "METRICS", false, metric(metrics.collects), metric(metrics.collects) ? 1 : 0, 1, "DETAIL_COLLECTS_MISSING"),
    field("metrics.comments", "METRICS", false, metric(metrics.comments), metric(metrics.comments) ? 1 : 0, 1, "DETAIL_COMMENTS_METRIC_MISSING"),
    field("metrics.shares", "METRICS", false, metric(metrics.shares), metric(metrics.shares) ? 1 : 0, 1, "DETAIL_SHARES_MISSING", "转发数仅在当前可见页面确实展示时记录；不可见时保持缺失。"),
    field("assets.visibleCandidates", "ASSETS", false, Array.isArray(snapshot.assets), list(snapshot.assets).length, null, "DETAIL_ASSET_LIST_MISSING", "候选资源仍需人工确认是否属于正文轮播、视频或封面。"),
    field("comments.visible", "COMMENTS", true, Array.isArray(snapshot.visibleComments), commentCount, null, "COMMENT_LIST_MISSING"),
    field("comments.traversalClosure", "COMMENTS", true, traversal.complete === true, traversal.fetchedTotal ?? traversal.visibleCommentCount ?? commentCount, null, "COMMENT_TRAVERSAL_NOT_CLOSED"),
    field("comments.retentionEvidence", "COMMENTS", true, fetchedCommentCount >= commentCount && traversal.retainedTotal === commentCount, commentCount, fetchedCommentCount, "COMMENT_RETENTION_EVIDENCE_MISMATCH"),
    field("comments.platformCommentId", "COMMENTS", commentsNeedIdentity, !commentsNeedIdentity || countWith((item) => Boolean(text(item.platformCommentId))) === commentCount, countWith((item) => Boolean(text(item.platformCommentId))), commentCount, "COMMENT_PLATFORM_ID_GAP"),
    field("comments.parentReplyRelation", "REPLIES", commentsNeedIdentity, !commentsNeedIdentity || countWith((item) => item.parentCommentId === null || Boolean(text(item.parentCommentId))) === commentCount, countWith((item) => item.parentCommentId === null || Boolean(text(item.parentCommentId))), commentCount, "COMMENT_PARENT_REPLY_RELATION_GAP"),
    field("comments.declaredTotal", "COMMENTS", false, Number.isInteger(snapshot.declaredCommentTotal) && snapshot.declaredCommentTotal >= 0, Number.isInteger(snapshot.declaredCommentTotal) ? 1 : 0, 1, "COMMENT_DECLARED_TOTAL_MISSING"),
  ];
}

export function validateBrowserSnapshotFields(snapshot, options = {}) {
  const pageType = ["SEARCH", "NOTE_DETAIL"].includes(snapshot?.pageType) ? snapshot.pageType : "UNKNOWN";
  const fields = pageType === "SEARCH" ? searchFields(snapshot) : pageType === "NOTE_DETAIL" ? detailFields(snapshot) : [];
  const statusBlocker = snapshot?.status !== "VISIBLE" || pageType === "UNKNOWN";
  const requiredGaps = fields.filter((item) => item.required && !item.present);
  const optionalGaps = fields.filter((item) => !item.required && !item.present);
  const machineCoverageStatus = statusBlocker || requiredGaps.length ? "BLOCKED" : optionalGaps.length ? "PARTIAL" : "COMPLETE";
  const evidenceClass = snapshot?.testFixture === true ? "CONTRACT_TEST" : "REAL_VISIBLE_PAGE";
  const overallStatus = evidenceClass === "CONTRACT_TEST" ? "CONTRACT_ONLY" : machineCoverageStatus === "BLOCKED" ? "BLOCKED" : machineCoverageStatus === "PARTIAL" ? "FIELD_GAPS" : "READY_FOR_HUMAN_COMPARE";
  const base = {
    schemaVersion: "1.0.0",
    receiptId: String(options.receiptId ?? ""),
    snapshotFingerprint: String(options.fingerprint ?? ""),
    pageType,
    evidenceClass,
    sourcePath: safeSourcePath(snapshot?.sourceUrl),
    capturedAt: text(snapshot?.capturedAt) || null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    machineCoverageStatus,
    humanComparisonStatus: evidenceClass === "CONTRACT_TEST" ? "NOT_APPLICABLE" : "NOT_STARTED",
    overallStatus,
    summary: { totalFields: fields.length, presentFields: fields.filter((item) => item.present).length, requiredGaps: requiredGaps.length + (statusBlocker ? 1 : 0), optionalGaps: optionalGaps.length },
    gaps: [
      ...(statusBlocker ? [snapshot?.status === "HUMAN_REQUIRED" ? "HUMAN_VERIFICATION_REQUIRED" : "SNAPSHOT_NOT_FIELD_VALIDATABLE"] : []),
      ...requiredGaps.map((item) => item.gapCode),
      ...optionalGaps.map((item) => item.gapCode),
    ].filter(Boolean),
    fields,
    boundaries: ["MACHINE_COVERAGE_DOES_NOT_PROVE_VALUE_CORRECTNESS", "HUMAN_PAGE_TO_RECEIPT_COMPARISON_REQUIRED", "REAL_PLATFORM_VALIDATION_NOT_COMPLETE_UNTIL_HUMAN_COMPARISON_PASSES"],
  };
  return { ...base, sha256: createHash("sha256").update(JSON.stringify(base), "utf8").digest("hex") };
}
