import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveRanking } from "./live-ranking.js";

const completeDetail = (noteId, overallStatus = "PARTIAL") => ({ noteId, detail: { status: "COMPLETE" }, overallStatus });

test("turns latest ranking evidence into an actionable list", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ scopeLabel: "发现页", coverage: "COMPLETE", observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n1", rank: 2 }] }], latestSignals: [{ noteId: "n1", kind: "RISING", rankDelta: 3 }] }],
    notes: [{ noteId: "n1", title: "可执行选题", author: { displayName: "作者" }, metrics: { likes: 100, collects: 30, comments: 8, shares: 6, observedAt: "2026-09-25T10:00:01Z" }, provenance: { sourceUrls: ["https://www.xiaohongshu.com/explore/n1"] } }],
    rawEnvelopes: [{ kind: "COMMENT_PAGE", collectedAt: "2026-09-25T10:00:01Z", payload: { noteId: "n1", observations: [{ text: "想要教程" }], traversal: { declaredTotal: 8, fetchedTotal: 8, commentFetchSucceeded: true } } }],
    completenessLedgers: [completeDetail("n1", "COMPLETE")],
  });
  assert.equal(result.status, "LIVE_EVIDENCE");
  assert.equal(result.rows[0].shares, 6);
  assert.equal(result.rows[0].evidenceStatus, "ELIGIBLE");
  assert.match(result.rows[0].reason, /上升 3 位/);
  assert.match(result.rows[0].reason, /收藏意图较强/);
});

test("does not manufacture a live list without ranking evidence", () => {
  const result = buildLiveRanking({ notes: [{ noteId: "detail-only" }] });
  assert.equal(result.status, "NO_LIVE_EVIDENCE");
  assert.deepEqual(result.rows, []);
});

test("keeps unobserved metrics missing rather than zero", () => {
  const result = buildLiveRanking({ rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n1", rank: 1 }] }], latestSignals: [] }], notes: [{ noteId: "n1", title: "A", author: {}, metrics: {}, provenance: { sourceUrls: [] } }], rawEnvelopes: [{ kind: "COMMENT_PAGE", collectedAt: "2026-09-25T10:00:01Z", payload: { noteId: "n1", observations: [], traversal: { declaredTotal: 0, fetchedTotal: 0, commentFetchSucceeded: true } } }], completenessLedgers: [completeDetail("n1", "COMPLETE")] });
  assert.equal(result.rows[0].likes, null);
  assert.equal(result.rows[0].shares, null);
});

test("uses the newest detail evidence and exposes same-post metric changes", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{
      updatedAt: "2026-09-25T10:10:00Z",
      snapshots: [{ observedAt: "2026-09-25T10:10:00Z", entries: [{ noteId: "n-change", rank: 1 }] }],
      latestSignals: [],
    }],
    notes: [],
    rawEnvelopes: [
      { kind: "SEARCH_RESULTS", collectedAt: "2026-09-25T10:00:00Z", payload: { cards: [{ noteId: "n-change", title: "同一条帖子", authorName: "作者", likes: 100, sourceUrl: "https://www.xiaohongshu.com/explore/n-change" }] } },
      { kind: "NOTE_DETAIL", collectedAt: "2026-09-25T10:01:00Z", payload: { noteId: "n-change", title: "同一条帖子", metrics: { likes: 100, collects: 20, comments: 3, shares: 4 } } },
      { kind: "SEARCH_RESULTS", collectedAt: "2026-09-25T10:10:00Z", payload: { cards: [{ noteId: "n-change", title: "同一条帖子", authorName: "作者", likes: 140, sourceUrl: "https://www.xiaohongshu.com/explore/n-change" }] } },
      { kind: "NOTE_DETAIL", collectedAt: "2026-09-25T10:11:00Z", payload: { noteId: "n-change", title: "同一条帖子", metrics: { likes: 140, collects: 31, comments: 5, shares: 9 } } },
    ],
  });

  assert.equal(result.rows[0].collects, 31);
  assert.equal(result.rows[0].shares, 9);
  assert.equal(result.rows[0].metricHistory.length, 4);
  // The two most recent like observations are both 140: this is unchanged,
  // not a repeat of the earlier +40 movement.
  assert.deepEqual(result.rows[0].metricDelta, { likes: 0, collects: 11, comments: 2, shares: 5 });
});

test("admits raw search candidates immediately without waiting for detail enrichment", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n-live", rank: 1 }] }], latestSignals: [] }],
    notes: [],
    rawEnvelopes: [{ kind: "SEARCH_RESULTS", collectedAt: "2026-09-25T10:00:00Z", payload: { cards: [{ noteId: "n-live", title: "实时标题", authorName: "实时作者", likes: 345, mediaType: "VIDEO", sourceUrl: "https://www.xiaohongshu.com/search_result/n-live" }] } }],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].title, "实时标题");
  assert.equal(result.rows[0].likes, 345);
  assert.equal(result.rows[0].mediaType, "VIDEO");
  assert.equal(result.rows[0].evidenceStatus, "SEARCH_ONLY");
});

test("keeps all three visible search-card interactions without opening a note", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n-three", rank: 1 }] }], latestSignals: [] }],
    notes: [],
    rawEnvelopes: [{ kind: "SEARCH_RESULTS", collectedAt: "2026-09-25T10:00:00Z", payload: { cards: [{ noteId: "n-three", title: "三项互动", authorName: "作者", likes: 30, collects: 12, shares: 4, sourceUrl: "https://www.xiaohongshu.com/explore/n-three" }] } }],
  });
  assert.deepEqual([result.rows[0].likes, result.rows[0].collects, result.rows[0].shares], [30, 12, 4]);
  assert.equal(result.rows[0].evidenceStatus, "DISCOVERED");
});

test("does not block a normalized note because comments were not collected", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n-gap", rank: 1 }] }], latestSignals: [] }],
    notes: [{ noteId: "n-gap", title: "只有详情没有评论", author: { displayName: "作者" }, metrics: { comments: 12 }, provenance: { sourceUrls: [] } }],
    rawEnvelopes: [{ kind: "COMMENT_PAGE", collectedAt: "2026-09-25T10:00:01Z", payload: { noteId: "n-gap", observations: [], traversal: { declaredTotal: 12, fetchedTotal: 0, commentFetchSucceeded: false } } }],
    completenessLedgers: [completeDetail("n-gap")],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].evidenceStatus, "ELIGIBLE");
});

test("keeps media-incomplete notes eligible for metadata-first ranking", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n-media-gap", rank: 1 }] }], latestSignals: [] }],
    notes: [{ noteId: "n-media-gap", title: "素材缺失", author: { displayName: "作者" }, metrics: { comments: 3 }, provenance: { sourceUrls: [] } }],
    rawEnvelopes: [{ kind: "COMMENT_PAGE", collectedAt: "2026-09-25T10:00:01Z", payload: { noteId: "n-media-gap", observations: [{ text: "求教程" }], traversal: { declaredTotal: 3, fetchedTotal: 3, commentFetchSucceeded: true } } }],
    completenessLedgers: [{ noteId: "n-media-gap", detail: { status: "PARTIAL" }, overallStatus: "PARTIAL" }],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].evidenceStatus, "ELIGIBLE");
});

test("merges complete notes from every latest scope instead of replacing the previous list", () => {
  const commentEvidence = (noteId, at) => ({ kind: "COMMENT_PAGE", collectedAt: at, payload: { noteId, observations: [], traversal: { declaredTotal: 0, fetchedTotal: 0, commentFetchSucceeded: true } } });
  const result = buildLiveRanking({
    rankingLedgers: [
      { updatedAt: "2026-09-25T09:00:00Z", snapshots: [{ scopeLabel: "儿童画", observedAt: "2026-09-25T09:00:00Z", entries: [{ noteId: "n1", rank: 1 }, { noteId: "n2", rank: 2 }] }], latestSignals: [] },
      { updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ scopeLabel: "亲子画画", observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n3", rank: 1 }] }], latestSignals: [] },
    ],
    notes: [
      { noteId: "n1", title: "一", author: {}, metrics: { likes: 30 }, provenance: { sourceUrls: [] } },
      { noteId: "n2", title: "二", author: {}, metrics: { likes: 20 }, provenance: { sourceUrls: [] } },
      { noteId: "n3", title: "三", author: {}, metrics: { likes: 10 }, provenance: { sourceUrls: [] } },
    ],
    rawEnvelopes: [commentEvidence("n1", "2026-09-25T09:00:01Z"), commentEvidence("n2", "2026-09-25T09:00:02Z"), commentEvidence("n3", "2026-09-25T10:00:01Z")],
    completenessLedgers: [completeDetail("n1", "COMPLETE"), completeDetail("n2", "COMPLETE"), completeDetail("n3", "COMPLETE")],
  });
  assert.deepEqual(result.rows.map((row) => row.noteId), ["n1", "n2", "n3"]);
  assert.equal(result.scopeLabel, "多关键词实时榜（2 个范围）");
});

test("deduplicates a note seen in multiple scopes and keeps its newest scope evidence", () => {
  const result = buildLiveRanking({
    rankingLedgers: [
      { updatedAt: "2026-09-25T09:00:00Z", snapshots: [{ scopeLabel: "旧范围", observedAt: "2026-09-25T09:00:00Z", entries: [{ noteId: "n1", rank: 1 }] }], latestSignals: [] },
      { updatedAt: "2026-09-25T10:00:00Z", snapshots: [{ scopeLabel: "新范围", observedAt: "2026-09-25T10:00:00Z", entries: [{ noteId: "n1", rank: 4 }] }], latestSignals: [] },
    ],
    notes: [{ noteId: "n1", title: "重复作品", author: {}, metrics: { likes: 1 }, provenance: { sourceUrls: [] } }],
    rawEnvelopes: [{ kind: "COMMENT_PAGE", collectedAt: "2026-09-25T10:00:01Z", payload: { noteId: "n1", observations: [], traversal: { declaredTotal: 0, fetchedTotal: 0, commentFetchSucceeded: true } } }],
    completenessLedgers: [completeDetail("n1", "COMPLETE")],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceScope, "新范围");
  assert.equal(result.rows[0].sourceRank, 4);
});

test("keeps ranking recheck time separate from older metric observation", () => {
  const result = buildLiveRanking({
    rankingLedgers: [{ snapshots: [{ scopeLabel: "家庭收纳", observedAt: "2026-09-25T12:00:00Z", entries: [{ noteId: "n1", rank: 1 }] }], latestSignals: [] }],
    notes: [{ noteId: "n1", title: "收纳方法", metrics: { likes: 10, observedAt: "2026-09-25T09:00:00Z" } }],
  });
  assert.equal(result.rows[0].observedAt, "2026-09-25T09:00:00Z");
  assert.equal(result.rows[0].lastSeenAt, "2026-09-25T12:00:00Z");
});
