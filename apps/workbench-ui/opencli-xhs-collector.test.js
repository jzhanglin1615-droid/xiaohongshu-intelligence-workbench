import assert from "node:assert/strict";
import test from "node:test";
import {
  buildXhsDetailExtractionScript,
  buildOpenCliDetailSnapshot,
  buildOpenCliSearchSnapshot,
  collectXhsDetailBundle,
  collectXhsKeyword,
  extractXhsNoteId,
  normalizeXhsAssets,
  operationalXhsNoteUrl,
  openCliBrowserTimeoutSeconds,
  parseCliJson,
  parseXhsMetric,
  selectUsefulComments,
} from "./opencli-xhs-collector.js";

const imageAsset = { type: "image", url: "https://sns-webpic-qc.xhscdn.com/example.jpg" };

function detailBundle({ title = "真实标题", author = "真实作者", comments = [], declaredComments = comments.filter((item) => !item.is_reply).length } = {}) {
  return {
    detail: { title, author, body: "真实正文", tags: ["测试"], metrics: { likes: "12", collects: "4", comments: String(declaredComments), shares: "1" } },
    media: [imageAsset],
    assetExtractionSucceeded: true,
    expectedAssetCount: 1,
    comments,
    commentTraversal: { sectionObserved: declaredComments === 0 || comments.length > 0, bottomReached: true },
  };
}

test("lets OpenCLI browser work use the outer command budget instead of its 60 second default", () => {
  assert.equal(openCliBrowserTimeoutSeconds(120_000), 105);
  assert.equal(openCliBrowserTimeoutSeconds(180_000), 165);
});

test("extracts JSON even when OpenCLI prints warnings and an update notice", () => {
  const output = `(node:42) [UNDICI-EHPA] Warning: experimental\n[{"rank":1,"title":"真实标题"}]\n\n  Update available: v1 → v2`;
  assert.deepEqual(parseCliJson(output), [{ rank: 1, title: "真实标题" }]);
});

test("normalizes Xiaohongshu compact metrics without inventing missing values", () => {
  assert.equal(parseXhsMetric("1.2万"), 12000);
  assert.equal(parseXhsMetric("3,456"), 3456);
  assert.equal(parseXhsMetric("2.5k"), 2500);
  assert.equal(parseXhsMetric("赞"), 0);
  assert.equal(parseXhsMetric(""), null);
});

test("extracts stable note ids from signed result URLs", () => {
  assert.equal(extractXhsNoteId("https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret"), "6ab4f76d000000001500b705");
  assert.equal(extractXhsNoteId("https://www.xiaohongshu.com/explore/not-an-id"), null);
});

test("makes signed search-result URLs operational without altering the token", () => {
  const input = "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret&xsec_source=";
  const result = new URL(operationalXhsNoteUrl(input));
  assert.equal(result.searchParams.get("xsec_token"), "secret");
  assert.equal(result.searchParams.get("xsec_source"), "pc_search");
});

test("builds one bounded detail script for content, media, comments and replies", () => {
  const script = buildXhsDetailExtractionScript("6ab4f76d000000001500b705", 500);
  assert.match(script, /__INITIAL_STATE__/);
  assert.match(script, /parent-comment/);
  assert.match(script, /reply-container/);
  assert.match(script, /commentLimit = Math\.max/);
  assert.match(script, /, 50\)$/);
});

test("keeps only unique Xiaohongshu media and preserves explicit media type", () => {
  const assets = normalizeXhsAssets([
    imageAsset,
    imageAsset,
    { type: "video", url: "https://sns-video-bd.xhscdn.com/example.mp4" },
    { type: "image", url: "data:image/png;base64,bad" },
    { type: "image", url: "https://example.com/not-platform.jpg" },
  ]);
  assert.deepEqual(assets.map((item) => item.type), ["IMAGE", "VIDEO"]);
  assert.equal(assets.length, 2);
});

test("opens, evaluates and always closes one isolated background detail session", async () => {
  const calls = [];
  const runJson = async (args) => {
    calls.push(args);
    if (args[2] === "open") return { url: args[3] };
    if (args[2] === "eval") return detailBundle();
    throw new Error("UNEXPECTED_JSON_CALL");
  };
  const runText = async (args) => { calls.push(args); return "closed"; };
  const result = await collectXhsDetailBundle({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret",
    noteId: "6ab4f76d000000001500b705",
    profile: "profile",
    sessionName: "test-session",
    runJson,
    runText,
  });
  assert.equal(result.detail.title, "真实标题");
  assert.deepEqual(calls.map((args) => args[2]), ["open", "eval", "close"]);
  assert.ok(calls[0].includes("background"));
});

test("closes the isolated detail session when extraction fails", async () => {
  const calls = [];
  const runJson = async (args) => {
    calls.push(args);
    if (args[2] === "open") return { url: args[3] };
    if (args[2] === "eval") throw new Error("DETAIL_EVAL_FAILED");
    throw new Error("UNEXPECTED_JSON_CALL");
  };
  const runText = async (args) => { calls.push(args); return "closed"; };
  await assert.rejects(() => collectXhsDetailBundle({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret",
    noteId: "6ab4f76d000000001500b705",
    profile: "profile",
    sessionName: "test-session",
    runJson,
    runText,
  }), /DETAIL_EVAL_FAILED/);
  assert.deepEqual(calls.map((args) => args[2]), ["open", "eval", "close"]);
});

test("retains high-agreement and demand comments while dropping noise and duplicates", () => {
  const selected = selectUsefulComments([
    { ordinal: 1, author: "A", text: "哈哈哈", likes: 99, isReply: false },
    { ordinal: 2, author: "B", text: "这个模板在哪里买？", likes: 0, isReply: false },
    { ordinal: 3, author: "C", text: "这个步骤很适合新手", likes: 8, isReply: false },
    { ordinal: 4, author: "D", text: "这个模板在哪里买？", likes: 0, isReply: false },
    { ordinal: 5, author: "作者", text: "可以在主页找到教程", likes: 0, isReply: true, replyTo: "B" },
  ]);
  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.map((item) => item.text)), new Set(["这个模板在哪里买？", "这个步骤很适合新手", "可以在主页找到教程"]));
  assert.ok(selected.find((item) => item.text === "这个模板在哪里买？")?.selectionReasons.includes("QUESTION_OR_INFORMATION_NEED"));
});

test("builds a ranking snapshot from real OpenCLI search rows", () => {
  const snapshot = buildOpenCliSearchSnapshot({
    keyword: "小红书",
    capturedAt: "2026-09-25T03:00:00.000Z",
    rows: [{ rank: 2, title: "真实标题", author: "真实作者", likes: "1.2万", url: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret" }],
  });
  assert.equal(snapshot.pageType, "SEARCH");
  assert.equal(snapshot.cards[0].noteId, "6ab4f76d000000001500b705");
  assert.equal(snapshot.cards[0].likes, 12000);
  assert.equal(snapshot.cards[0].ordinal, 2);
});

test("builds detail and comment closure from OpenCLI note and reply rows", () => {
  const snapshot = buildOpenCliDetailSnapshot({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret",
    noteId: "6ab4f76d000000001500b705",
    capturedAt: "2026-09-25T03:01:00.000Z",
    noteRows: [
      { field: "title", value: "真实标题" },
      { field: "author", value: "真实作者" },
      { field: "content", value: "真实正文" },
      { field: "likes", value: "12" },
      { field: "collects", value: "4" },
      { field: "comments", value: "1" },
      { field: "shares", value: "1" },
    ],
    commentRows: [{ rank: 1, author: "评论者", userId: "user-1", text: "真实评论", likes: "2", time: "昨天", is_reply: false, reply_to: null }],
    assets: [imageAsset],
    assetExtractionSucceeded: true,
    expectedAssetCount: 1,
    commentLimit: 50,
  });
  assert.equal(snapshot.noteTitle, "真实标题");
  assert.equal(snapshot.metrics.collects, 4);
  assert.equal(snapshot.visibleComments[0].authorUserId, "user-1");
  assert.equal(snapshot.commentTraversal.declaredTotal, 1);
  assert.equal(snapshot.commentTraversal.fetchedTotal, 1);
  assert.equal(snapshot.commentTraversal.retainedTotal, 1);
  assert.equal(snapshot.commentTraversal.complete, true);
  assert.equal(snapshot.commentTraversal.sectionObserved, true);
  assert.equal(snapshot.admission.status, "ADMITTED");
});

test("orchestrates search, detail and comments and prefers unenriched notes", async () => {
  const calls = [];
  const snapshots = [];
  const url1 = "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=one";
  const url2 = "https://www.xiaohongshu.com/search_result/6ab5aab9000000001303d1ce?xsec_token=two";
  const runCli = async (args) => {
    calls.push(args);
    if (args[1] === "search") return [
      { rank: 1, title: "已有", author: "A", likes: "8", url: url1 },
      { rank: 2, title: "待补", author: "B", likes: "7", url: url2 },
    ];
    throw new Error("DETAIL_MUST_USE_ONE_BUNDLE");
  };
  const runDetailBundle = async ({ noteId }) => detailBundle({ title: "待补", author: "B", comments: [{ rank: 1, author: "C", text: "怎么操作？", likes: "3", is_reply: false }], declaredComments: 1, noteId });
  const persistAndIngest = async (snapshot) => {
    snapshots.push(snapshot);
    return { receiptId: `receipt-${snapshots.length}`, ingestion: { rankingSnapshotIds: snapshot.pageType === "SEARCH" ? ["ranking-real"] : [], normalizedNoteIds: snapshot.pageType === "NOTE_DETAIL" ? [snapshot.noteId] : [] } };
  };
  const result = await collectXhsKeyword({ keyword: "小红书", profile: "profile", searchLimit: 2, detailLimit: 1, commentLimit: 50, existingNoteIds: ["6ab4f76d000000001500b705"], runCli, runDetailBundle, persistAndIngest, now: () => "2026-09-25T03:00:00.000Z" });
  assert.equal(result.rankingSnapshotId, "ranking-real");
  assert.equal(result.searchCards.length, 2);
  assert.deepEqual(result.normalizedNoteIds, ["6ab5aab9000000001303d1ce"]);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].noteId, "6ab5aab9000000001303d1ce");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "search");
  assert.equal(snapshots[1].assets.length, 1);
});

test("tries the next high-engagement candidate when a detail navigation fails", async () => {
  const calls = [];
  const snapshots = [];
  const ids = ["6ab4f76d000000001500b705", "6ab5aab9000000001303d1ce", "6ab6aab9000000001303d1cf"];
  const runCli = async (args) => {
    calls.push(args);
    if (args[1] === "search") return [
      { rank: 3, title: "低热度", author: "C", likes: "1", url: `https://www.xiaohongshu.com/search_result/${ids[2]}?xsec_token=three` },
      { rank: 1, title: "最高热度但失效", author: "A", likes: "99", url: `https://www.xiaohongshu.com/search_result/${ids[0]}?xsec_token=one` },
      { rank: 2, title: "次高热度成功", author: "B", likes: "50", url: `https://www.xiaohongshu.com/search_result/${ids[1]}?xsec_token=two` },
    ];
    throw new Error("DETAIL_MUST_USE_ONE_BUNDLE");
  };
  const bundleCalls = [];
  const runDetailBundle = async ({ noteId }) => {
    bundleCalls.push(noteId);
    if (noteId === ids[0]) throw new Error("Navigation rejected");
    return detailBundle({ title: "次高热度成功", author: "B", declaredComments: 0 });
  };
  const persistAndIngest = async (snapshot) => {
    snapshots.push(snapshot);
    return { receiptId: `receipt-${snapshots.length}`, ingestion: { rankingSnapshotIds: snapshot.pageType === "SEARCH" ? ["ranking-real"] : [], normalizedNoteIds: snapshot.pageType === "NOTE_DETAIL" ? [snapshot.noteId] : [] } };
  };
  const result = await collectXhsKeyword({ keyword: "小红书", profile: "profile", detailLimit: 1, runCli, runDetailBundle, persistAndIngest, now: () => "2026-09-25T03:00:00.000Z" });
  assert.deepEqual(bundleCalls, [ids[0], ids[1]]);
  assert.equal(result.detailAttempted, 2);
  assert.equal(result.detailSucceeded, 1);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(calls.length, 1);
  assert.equal(snapshots.at(-1).commentTraversal.commentFetchSkippedBecauseZero, true);
});

test("skips the comment page only when the detail page explicitly declares zero comments", async () => {
  const calls = [];
  const snapshots = [];
  const noteId = "6ab7aab9000000001303d1d0";
  const sourceUrl = `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=zero`;
  const runCli = async (args) => {
    calls.push(args);
    if (args[1] === "search") return [{ rank: 1, title: "零评论作品", author: "作者", likes: "12", url: sourceUrl }];
    throw new Error("DETAIL_MUST_USE_ONE_BUNDLE");
  };
  const runDetailBundle = async () => detailBundle({ title: "零评论作品", author: "作者", declaredComments: 0 });
  const persistAndIngest = async (snapshot) => {
    snapshots.push(snapshot);
    return {
      receiptId: `receipt-${snapshots.length}`,
      ingestion: {
        rankingSnapshotIds: snapshot.pageType === "SEARCH" ? ["ranking-zero"] : [],
        normalizedNoteIds: snapshot.pageType === "NOTE_DETAIL" ? [snapshot.noteId] : [],
      },
    };
  };
  const result = await collectXhsKeyword({
    keyword: "小红书",
    profile: "profile",
    detailLimit: 1,
    runCli,
    runDetailBundle,
    persistAndIngest,
    now: () => "2026-09-25T03:02:00.000Z",
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(calls.filter((args) => args[1] === "comments").length, 0);
  assert.equal(snapshots.at(-1).admission.status, "ADMITTED");
  assert.equal(snapshots.at(-1).commentTraversal.declaredTotal, 0);
  assert.equal(snapshots.at(-1).commentTraversal.commentFetchSkippedBecauseZero, true);
});

test("rejects a note from workbench admission when declared comments were not fetched", () => {
  const snapshot = buildOpenCliDetailSnapshot({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret&xsec_source=pc_search",
    noteId: "6ab4f76d000000001500b705",
    capturedAt: "2026-09-25T03:01:00.000Z",
    noteRows: [{ field: "title", value: "真实标题" }, { field: "author", value: "真实作者" }, { field: "comments", value: "3" }],
    commentRows: [],
    assets: [imageAsset],
    assetExtractionSucceeded: true,
    expectedAssetCount: 1,
    commentFetchSucceeded: true,
  });
  assert.equal(snapshot.admission.status, "REJECTED");
  assert.ok(snapshot.admission.reasons.includes("DECLARED_COMMENTS_NOT_CAPTURED"));
});

test("rejects a note from workbench admission when正文 or interaction metrics are incomplete", () => {
  const snapshot = buildOpenCliDetailSnapshot({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret&xsec_source=pc_search",
    noteId: "6ab4f76d000000001500b705",
    capturedAt: "2026-09-25T03:01:00.000Z",
    noteRows: [{ field: "title", value: "真实标题" }, { field: "author", value: "真实作者" }, { field: "likes", value: "10" }, { field: "collects", value: "2" }, { field: "comments", value: "0" }],
    assets: [imageAsset],
    assetExtractionSucceeded: true,
    expectedAssetCount: 1,
    commentFetchSucceeded: true,
    commentFetchSkippedBecauseZero: true,
  });
  assert.equal(snapshot.admission.status, "REJECTED");
  assert.ok(snapshot.admission.reasons.includes("DETAIL_BODY_MISSING"));
  assert.ok(snapshot.admission.reasons.includes("DETAIL_METRICS_INCOMPLETE"));
});

test("rejects a detail snapshot when its work media were not captured", () => {
  const snapshot = buildOpenCliDetailSnapshot({
    sourceUrl: "https://www.xiaohongshu.com/search_result/6ab4f76d000000001500b705?xsec_token=secret&xsec_source=pc_search",
    noteId: "6ab4f76d000000001500b705",
    capturedAt: "2026-09-25T03:01:00.000Z",
    noteRows: [{ field: "title", value: "真实标题" }, { field: "author", value: "真实作者" }, { field: "content", value: "真实正文" }, { field: "comments", value: "0" }],
    commentRows: [],
    assets: [],
    assetExtractionSucceeded: true,
    expectedAssetCount: 0,
    commentFetchSucceeded: true,
    commentFetchSkippedBecauseZero: true,
  });
  assert.equal(snapshot.admission.status, "REJECTED");
  assert.ok(snapshot.admission.reasons.includes("DETAIL_ASSETS_NOT_CAPTURED"));
});
