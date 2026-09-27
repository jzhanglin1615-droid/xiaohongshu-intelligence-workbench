import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestBrowserSnapshot, type BrowserSnapshotReceipt } from "../src/browser-snapshot-ingestion.ts";
import { FileEvidenceStore } from "../src/file-store.ts";

function receipt(id: string, snapshot: Record<string, unknown>): BrowserSnapshotReceipt {
  const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { receiptId: id, fingerprint, snapshotPath: `state/browser-bridge/snapshots/${id}.json`, snapshot };
}

const searchSnapshot = {
  pageType: "SEARCH",
  status: "VISIBLE",
  sourceUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1",
  capturedAt: "2026-09-25T01:00:00.000Z",
  keyword: "咖啡",
  cards: [{ ordinal: 1, noteId: "note-live-1", title: "一杯咖啡", authorName: "作者甲", sourceUrl: "https://www.xiaohongshu.com/explore/note-live-1", likes: 120 }],
};

const detailSnapshot = {
  pageType: "NOTE_DETAIL",
  status: "VISIBLE",
  sourceUrl: "https://www.xiaohongshu.com/explore/note-live-1",
  capturedAt: "2026-09-25T01:01:00.000Z",
  noteId: "note-live-1",
  noteTitle: "一杯咖啡",
  authorName: "作者甲",
  body: "正文",
  metrics: { likes: 130, collects: 20, comments: 2 },
  assets: ["https://sns-webpic-qc.xhscdn.com/example.jpg"],
  assetExtractionSucceeded: true,
  expectedAssetCount: 1,
  visibleComments: [{ ordinal: 1, author: "路人", text: "不错", rawText: "路人 不错" }],
  commentTraversal: { visibleCommentCount: 1, expandableReplyCount: 0, hasMoreRootComments: false, bottomReached: true, complete: true },
};

test("browser search snapshot persists evidence, an ordered ranking snapshot, and a gap-refill plan", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-search-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  const result = await ingestBrowserSnapshot({ receipt: receipt("search-1", searchSnapshot), databasePath, ingestedAt: "2026-09-25T01:00:01.000Z" });
  const store = new FileEvidenceStore(databasePath);

  assert.equal(result.status, "RAW_PERSISTED");
  assert.equal(result.envelopeIds.length, 1);
  assert.equal(result.rankingSnapshotIds.length, 1);
  assert.equal(result.enrichmentPlanIds.length, 1);
  assert.deepEqual(result.enrichmentTargets, [{ planId: result.enrichmentPlanIds[0], noteId: "note-live-1", priority: 100, stages: ["DETAIL", "COMMENTS"] }]);
  assert.equal((await store.listRawEnvelopes())[0].kind, "SEARCH_RESULTS");
  assert.equal((await store.getRankingLedger("search:E59296E595A1"))?.snapshots[0].coverage, "UNKNOWN");
  assert.equal((await store.getEnrichmentPlan(result.enrichmentPlanIds[0]))?.tasks[0].noteId, "note-live-1");
});

test("video search cards are persisted and ranked but excluded from detail enrichment", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-video-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  const videoSearch = {
    ...searchSnapshot,
    capturedAt: "2026-09-25T01:00:10.000Z",
    cards: [{ ...searchSnapshot.cards[0], noteId: "video-live-1", sourceUrl: "https://www.xiaohongshu.com/explore/video-live-1", mediaType: "VIDEO" }],
  };
  const result = await ingestBrowserSnapshot({ receipt: receipt("search-video", videoSearch), databasePath, ingestedAt: "2026-09-25T01:00:11.000Z" });
  const store = new FileEvidenceStore(databasePath);
  const raw = (await store.listRawEnvelopes())[0];
  const card = (raw.payload as { cards: Array<{ mediaType: string }> }).cards[0];

  assert.equal(result.rankingSnapshotIds.length, 1);
  assert.deepEqual(result.enrichmentTargets, []);
  assert.equal(card.mediaType, "VIDEO");
});

test("partial search progress updates ranking evidence without creating enrichment work", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-progress-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  const partialSearch = { ...searchSnapshot, collectionProgress: { partial: true, capturedCount: 25, targetCount: 1500 } };
  const result = await ingestBrowserSnapshot({ receipt: receipt("search-progress", partialSearch), databasePath, ingestedAt: "2026-09-25T01:00:01.000Z" });

  assert.equal(result.rankingSnapshotIds.length, 1);
  assert.deepEqual(result.enrichmentPlanIds, []);
  assert.deepEqual(result.enrichmentTargets, []);
});

test("matching search and detail snapshots close raw evidence into normalized note and provisional completeness", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-pair-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  await ingestBrowserSnapshot({ receipt: receipt("search-2", searchSnapshot), databasePath, ingestedAt: "2026-09-25T01:00:01.000Z" });
  const result = await ingestBrowserSnapshot({ receipt: receipt("detail-2", detailSnapshot), databasePath, ingestedAt: "2026-09-25T01:01:01.000Z" });
  const store = new FileEvidenceStore(databasePath);

  assert.equal(result.status, "NORMALIZED_WITH_GAPS");
  assert.deepEqual(result.normalizedNoteIds, ["note-live-1"]);
  assert.equal((await store.listRawEnvelopes()).length, 3);
  assert.equal((await store.listNotes()).length, 1);
  assert.equal((await store.listQuality())[0].decision, "PASS");
  const completeness = await store.getCompletenessLedger("note-live-1");
  assert.equal(completeness?.detail.status, "COMPLETE");
  assert.equal(completeness?.comments.status, "PROVISIONAL");
  assert.equal(completeness?.overallStatus, "PROVISIONAL");
  assert.equal(result.gaps.includes("COMMENT_PLATFORM_IDS_NOT_OBSERVABLE"), true);
});

test("detail without search is retained as raw evidence but cannot masquerade as normalized", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-detail-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  const input = receipt("detail-3", detailSnapshot);
  const result = await ingestBrowserSnapshot({ receipt: input, databasePath, ingestedAt: "2026-09-25T01:01:01.000Z" });
  const duplicate = await ingestBrowserSnapshot({ receipt: input, databasePath, ingestedAt: "2026-09-25T01:01:02.000Z" });
  const store = new FileEvidenceStore(databasePath);

  assert.equal(result.status, "RAW_PERSISTED");
  assert.equal(result.gaps.includes("MATCHING_SEARCH_EVIDENCE_REQUIRED_FOR_NORMALIZATION"), true);
  assert.equal((await store.listNotes()).length, 0);
  assert.equal((await store.listRawEnvelopes()).length, 2);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal((await store.getCompletenessLedger("note-live-1"))?.observationCount, 1);
});

test("a later search snapshot reconciles an already persisted detail snapshot", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-reconcile-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  await ingestBrowserSnapshot({ receipt: receipt("detail-4", detailSnapshot), databasePath, ingestedAt: "2026-09-25T01:01:01.000Z" });
  const laterSearch = { ...searchSnapshot, capturedAt: "2026-09-25T01:02:00.000Z" };
  const result = await ingestBrowserSnapshot({ receipt: receipt("search-4", laterSearch), databasePath, ingestedAt: "2026-09-25T01:02:01.000Z" });

  assert.deepEqual(result.normalizedNoteIds, ["note-live-1"]);
  assert.equal((await new FileEvidenceStore(databasePath).listNotes()).length, 1);
});

test("preserves visible comment fields, reply relations, and declared completeness", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-browser-ingest-comments-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "database.json");
  await ingestBrowserSnapshot({ receipt: receipt("search-comments", searchSnapshot), databasePath, ingestedAt: "2026-09-25T01:00:01.000Z" });
  const richDetail = {
    ...detailSnapshot,
    capturedAt: "2026-09-25T01:03:00.000Z",
    visibleComments: [
      { ordinal: 1, author: "路人", authorUserId: "user-1", profileUrl: "https://www.xiaohongshu.com/user/profile/user-1", text: "怎么做", rawText: "怎么做", likes: 3, publishedAt: "今天", isReply: false, replyTo: null },
      { ordinal: 2, author: "作者甲", authorUserId: "user-2", text: "这样做", rawText: "这样做", likes: 1, publishedAt: "今天", isReply: true, replyTo: "路人" },
    ],
    commentTraversal: { declaredTotal: 2, capturedTotal: 2, capturedTopLevel: 1, capturedReplies: 1, complete: true, bottomReached: true },
  };
  const result = await ingestBrowserSnapshot({ receipt: receipt("detail-comments", richDetail), databasePath, ingestedAt: "2026-09-25T01:03:01.000Z" });
  const store = new FileEvidenceStore(databasePath);
  const commentEnvelope = (await store.listRawEnvelopes()).find((item) => item.kind === "COMMENT_PAGE");
  const observations = (commentEnvelope?.payload as { observations: Array<Record<string, unknown>> }).observations;
  const completeness = await store.getCompletenessLedger("note-live-1");

  assert.equal(observations[0].authorUserId, "user-1");
  assert.equal(observations[1].isReply, true);
  assert.equal(observations[1].replyTo, "路人");
  assert.equal(completeness?.comments.platformDeclaredTotal, 2);
  assert.equal(completeness?.comments.capturedTopLevelCount, 1);
  assert.equal(completeness?.comments.capturedReplyCount, 1);
  assert.equal(completeness?.comments.status, "COMPLETE");
  assert.equal(result.gaps.includes("COMMENT_DECLARED_TOTAL_NOT_OBSERVABLE"), false);
  assert.equal(result.gaps.includes("COMMENT_PARENT_REPLY_RELATION_NOT_OBSERVABLE"), false);
});
