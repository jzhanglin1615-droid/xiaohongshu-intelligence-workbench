import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContract,
  type RawEnvelope,
  type RankingSnapshot,
} from "../../contracts/src/index.ts";
import { FileEvidenceStore } from "./file-store.ts";
import { SqliteEvidenceStore } from "./sqlite-store.ts";
import { listSearchCards, normalizeNote, type NoteDetailPayload, type SearchResultsPayload } from "./normalizer.ts";
import { evaluateNote } from "./quality.ts";
import { RankingWorkbench } from "./ranking-workbench.ts";

export interface BrowserSnapshotReceipt {
  receiptId: string;
  fingerprint: string;
  snapshotPath: string;
  snapshot: Record<string, unknown>;
}

export interface BrowserSnapshotIngestionReceipt {
  receiptId: string;
  status: "RAW_PERSISTED" | "NORMALIZED_WITH_GAPS" | "NORMALIZED" | "DUPLICATE";
  envelopeIds: string[];
  normalizedNoteIds: string[];
  rankingSnapshotIds: string[];
  enrichmentPlanIds: string[];
  enrichmentTargets: Array<{ planId: string; noteId: string; priority: number; stages: Array<"DETAIL" | "COMMENTS"> }>;
  gaps: string[];
  databasePath: string;
  ingestedAt: string;
}

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const nullableMetric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const localIdentity = (kind: string, value: string): string => value ? `${kind}-${digest(value.toLocaleLowerCase()).slice(0, 16)}` : "";
const scopePart = (value: string): string => encodeURIComponent(value.trim().toLocaleLowerCase()).replaceAll("%", "").slice(0, 80) || "unknown";

function envelope(input: BrowserSnapshotReceipt, kind: RawEnvelope["kind"], suffix: string, payload: unknown): RawEnvelope {
  const snapshot = input.snapshot;
  const result: RawEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    envelopeId: `browser-${kind.toLocaleLowerCase()}-${input.fingerprint.slice(0, 16)}-${suffix}`,
    kind,
    sourceUrl: stringValue(snapshot.sourceUrl),
    collectedAt: stringValue(snapshot.capturedAt),
    parserVersion: "browser-visible-dom/1.0.0",
    payload,
    evidence: { fixturePath: input.snapshotPath, sha256: input.fingerprint },
  };
  assertContract<RawEnvelope>("RawEnvelope", result);
  return result;
}

function searchEnvelope(input: BrowserSnapshotReceipt): { envelope: RawEnvelope; gaps: string[] } {
  const snapshot = input.snapshot;
  const keyword = stringValue(snapshot.keyword) || (() => {
    try { return new URL(stringValue(snapshot.sourceUrl)).searchParams.get("keyword")?.trim() ?? ""; } catch { return ""; }
  })();
  const gaps: string[] = [];
  if (!keyword) gaps.push("SEARCH_KEYWORD_MISSING");
  const rawCards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const cards = rawCards.map((value) => {
    const card = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const authorName = stringValue(card.authorName);
    const rawMediaType = stringValue(card.mediaType).toLocaleUpperCase();
    const mediaType = rawMediaType === "VIDEO" || rawMediaType === "IMAGE" ? rawMediaType : "UNKNOWN";
    return {
      noteId: stringValue(card.noteId),
      title: stringValue(card.title),
      authorId: localIdentity("visible-author", authorName),
      authorName,
      sourceUrl: stringValue(card.sourceUrl),
      coverUrl: stringValue(card.coverUrl) || null,
      likes: nullableMetric(card.likes),
      collects: nullableMetric(card.collects),
      shares: nullableMetric(card.shares),
      mediaType,
      ordinal: typeof card.ordinal === "number" ? card.ordinal : null,
      rawText: stringValue(card.rawText),
      identitySemantics: "authorId is evidence-local and is not a platform account ID",
    };
  }).filter((card) => card.noteId && card.sourceUrl);
  if (cards.length < rawCards.length) gaps.push("SEARCH_CARDS_WITHOUT_STABLE_NOTE_ID_OR_URL_DROPPED");
  if (cards.length === 0) gaps.push("SEARCH_HAS_NO_USABLE_CARDS");
  return { envelope: envelope(input, "SEARCH_RESULTS", "search", { keyword, cards } satisfies SearchResultsPayload), gaps };
}

function detailEnvelopes(input: BrowserSnapshotReceipt): { envelopes: RawEnvelope[]; gaps: string[]; noteId: string } {
  const snapshot = input.snapshot;
  const noteId = stringValue(snapshot.noteId);
  if (!noteId) throw new Error("BROWSER_DETAIL_NOTE_ID_MISSING");
  const gaps: string[] = [];
  const authorName = stringValue(snapshot.authorName);
  const rawAssets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
  const assets = rawAssets.map((value, index) => {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const sourceUrl = stringValue(record.sourceUrl) || stringValue(record.url) || stringValue(value);
    const explicitType = stringValue(record.type).toLocaleUpperCase();
    const video = explicitType === "VIDEO" || /\.(mp4|m3u8|mov)(?:$|\?)/i.test(sourceUrl);
    const cover = explicitType === "VIDEO_COVER";
    return { type: cover ? "VIDEO_COVER" as const : video ? "VIDEO" as const : "IMAGE" as const, ordinal: index + 1, sourceUrl };
  }).filter((asset) => asset.sourceUrl);
  const rawExpectedAssetCount = Number(snapshot.expectedAssetCount);
  const expectedAssetCount = Number.isFinite(rawExpectedAssetCount) && rawExpectedAssetCount >= 0
    ? Math.floor(rawExpectedAssetCount)
    : null;
  const rawMetrics = snapshot.metrics && typeof snapshot.metrics === "object" ? snapshot.metrics as Record<string, unknown> : {};
  const detailPayload: NoteDetailPayload = {
    noteId,
    title: stringValue(snapshot.noteTitle),
    body: stringValue(snapshot.body) || null,
    authorId: localIdentity("visible-author", authorName),
    authorName,
    sourceUrl: stringValue(snapshot.sourceUrl),
    metrics: { likes: nullableMetric(rawMetrics.likes), collects: nullableMetric(rawMetrics.collects), comments: nullableMetric(rawMetrics.comments), shares: nullableMetric(rawMetrics.shares) },
    expectedAssetCount,
    assets,
  };
  if (!detailPayload.title) gaps.push("DETAIL_TITLE_MISSING");
  if (!detailPayload.body) gaps.push("DETAIL_BODY_MISSING");
  if (!detailPayload.authorName) gaps.push("DETAIL_AUTHOR_MISSING");
  if (Object.values(detailPayload.metrics).every((value) => value === null)) gaps.push("DETAIL_METRICS_MISSING");
  if (snapshot.assetExtractionSucceeded !== true) gaps.push("ASSET_EXTRACTION_NOT_CONFIRMED");
  if (expectedAssetCount === null) gaps.push("ASSET_EXPECTED_COUNT_NOT_OBSERVABLE");
  else if (expectedAssetCount !== assets.length) gaps.push("ASSET_COUNT_MISMATCH");

  const detail = envelope(input, "NOTE_DETAIL", "detail", detailPayload);
  const visibleComments = (Array.isArray(snapshot.visibleComments) ? snapshot.visibleComments : []).map((value, index) => {
    const comment = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const author = stringValue(comment.author);
    const authorUserId = stringValue(comment.authorUserId) || stringValue(comment.userId) || null;
    const text = stringValue(comment.text);
    const rawText = stringValue(comment.rawText);
    const isReply = comment.isReply === true || comment.is_reply === true;
    const replyTo = stringValue(comment.replyTo) || stringValue(comment.reply_to) || null;
    return {
      evidenceLocalId: `visible-comment-${digest(`${noteId}|${index}|${authorUserId ?? author}|${text}|${rawText}`).slice(0, 20)}`,
      ordinal: typeof comment.ordinal === "number" ? comment.ordinal : index + 1,
      author,
      authorUserId,
      profileUrl: stringValue(comment.profileUrl) || null,
      text,
      rawText,
      likes: nullableMetric(comment.likes),
      publishedAt: stringValue(comment.publishedAt) || null,
      isReply,
      replyTo,
    };
  });
  const traversal = snapshot.commentTraversal && typeof snapshot.commentTraversal === "object"
    ? snapshot.commentTraversal as Record<string, unknown> : {};
  const comments = envelope(input, "COMMENT_PAGE", "comments", {
    noteId,
    observations: visibleComments,
    traversal,
    identitySemantics: "evidenceLocalId deduplicates visible fragments only; platform comment IDs were not observable; isReply/replyTo preserve visible reply relations when available",
  });
  gaps.push("COMMENT_PLATFORM_IDS_NOT_OBSERVABLE");
  if (visibleComments.some((comment) => comment.isReply && !comment.replyTo)) gaps.push("COMMENT_PARENT_REPLY_RELATION_NOT_OBSERVABLE");
  if (nullableMetric(traversal.declaredTotal) === null) gaps.push("COMMENT_DECLARED_TOTAL_NOT_OBSERVABLE");
  return { envelopes: [detail, comments], gaps, noteId };
}

function latestMatchingSearch(envelopes: RawEnvelope[], noteId: string): { keyword: string; card: ReturnType<typeof listSearchCards>[number]; envelope: RawEnvelope } | null {
  const matches = envelopes.filter((item) => item.kind === "SEARCH_RESULTS").flatMap((item) => {
    const payload = item.payload as SearchResultsPayload;
    const card = listSearchCards(item).find((candidate) => candidate.noteId === noteId);
    return card ? [{ keyword: payload.keyword, card, envelope: item }] : [];
  }).sort((a, b) => Date.parse(b.envelope.collectedAt) - Date.parse(a.envelope.collectedAt));
  return matches[0] ?? null;
}

export async function ingestBrowserSnapshot(input: {
  receipt: BrowserSnapshotReceipt;
  databasePath: string;
  ingestedAt?: string;
}): Promise<BrowserSnapshotIngestionReceipt> {
  const { receipt } = input;
  const snapshot = receipt.snapshot;
  if (snapshot.status !== "VISIBLE") throw new Error("BROWSER_SNAPSHOT_NOT_VISIBLE");
  if (!Number.isFinite(Date.parse(stringValue(snapshot.capturedAt)))) throw new Error("BROWSER_SNAPSHOT_CAPTURE_TIME_INVALID");
  const store = input.databasePath.toLocaleLowerCase().endsWith(".sqlite")
    ? new SqliteEvidenceStore(input.databasePath)
    : new FileEvidenceStore(input.databasePath);
  try {
  const existing = await store.listRawEnvelopes();
  const gaps: string[] = [];
  let built: RawEnvelope[];
  let noteId: string | null = null;
  if (snapshot.pageType === "SEARCH") {
    const result = searchEnvelope(receipt);
    built = [result.envelope];
    gaps.push(...result.gaps);
  } else if (snapshot.pageType === "NOTE_DETAIL") {
    const result = detailEnvelopes(receipt);
    built = result.envelopes;
    noteId = result.noteId;
    gaps.push(...result.gaps);
  } else throw new Error("BROWSER_SNAPSHOT_PAGE_TYPE_UNSUPPORTED");

  if (built.every((item) => existing.some((current) => current.envelopeId === item.envelopeId))) {
    return { receiptId: receipt.receiptId, status: "DUPLICATE", envelopeIds: built.map((item) => item.envelopeId), normalizedNoteIds: [], rankingSnapshotIds: [], enrichmentPlanIds: [], enrichmentTargets: [], gaps: ["DUPLICATE_RECEIPT_ALREADY_PERSISTED"], databasePath: input.databasePath, ingestedAt: input.ingestedAt ?? new Date().toISOString() };
  }
  await store.saveRawEnvelopes(built);
  const all = await store.listRawEnvelopes();
  const ranking = new RankingWorkbench(store);
  const rankingSnapshotIds: string[] = [];
  const enrichmentPlanIds: string[] = [];
  const enrichmentTargets: BrowserSnapshotIngestionReceipt["enrichmentTargets"] = [];
  const normalizedNoteIds: string[] = [];

  if (snapshot.pageType === "SEARCH") {
    const search = built[0];
    const payload = search.payload as SearchResultsPayload;
    const cards = listSearchCards(search);
    const collectionProgress = snapshot.collectionProgress && typeof snapshot.collectionProgress === "object" ? snapshot.collectionProgress as Record<string, unknown> : {};
    const partialSearchProgress = collectionProgress.partial === true;
    if (cards.length) {
      const scopeId = `search:${scopePart(payload.keyword)}`;
      const rankingSnapshot: RankingSnapshot = {
        schemaVersion: CONTRACT_VERSION,
        snapshotId: `browser-ranking-${receipt.fingerprint.slice(0, 20)}`,
        scopeId,
        scopeLabel: `搜索结果：${payload.keyword || "关键词缺失"}`,
        coverage: "UNKNOWN",
        expectedSlots: null,
        entries: cards.map((card, index) => ({ noteId: card.noteId, rank: index + 1, sourceEnvelopeId: search.envelopeId })),
        observedAt: search.collectedAt,
      };
      try {
        await ranking.recordRankingSnapshot(rankingSnapshot);
        rankingSnapshotIds.push(rankingSnapshot.snapshotId);
        if (!partialSearchProgress) {
          const planId = `browser-enrichment-${receipt.fingerprint.slice(0, 20)}`;
          const plan = await ranking.planEnrichment({ planId, scopeId, policy: { maxTargets: Math.min(50, cards.length), includeComments: true }, createdAt: input.ingestedAt ?? new Date().toISOString() });
          enrichmentPlanIds.push(planId);
          const mediaTypeByNoteId = new Map(cards.map((card) => [card.noteId, card.mediaType]));
          enrichmentTargets.push(...plan.tasks
            .filter((task) => mediaTypeByNoteId.get(task.noteId) !== "VIDEO")
            .map((task) => ({ planId, noteId: task.noteId, priority: task.priority, stages: task.stages })));
        }
      } catch (error) {
        gaps.push(error instanceof Error ? `RANKING_LEDGER_NOT_UPDATED:${error.message}` : "RANKING_LEDGER_NOT_UPDATED");
      }
    }
    for (const card of cards) {
      const details = all.filter((item) => item.kind === "NOTE_DETAIL" && (item.payload as NoteDetailPayload).noteId === card.noteId)
        .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
      if (!details[0]) continue;
      const note = normalizeNote({ keyword: payload.keyword, card, searchEnvelope: search, detailEnvelope: details[0] });
      await store.upsertNotes([note]);
      await store.saveQuality([evaluateNote(note, input.ingestedAt ?? new Date().toISOString())]);
      normalizedNoteIds.push(note.noteId);
    }
  }

  if (noteId) {
    const detail = built.find((item) => item.kind === "NOTE_DETAIL")!;
    const comments = built.find((item) => item.kind === "COMMENT_PAGE")!;
    const payload = detail.payload as NoteDetailPayload;
    const commentsPayload = comments.payload as { observations?: Array<{ evidenceLocalId?: string; author?: string; isReply?: boolean; replyTo?: string | null }> };
    const observedComments = Array.isArray(commentsPayload.observations) ? commentsPayload.observations : [];
    const traversal = snapshot.commentTraversal && typeof snapshot.commentTraversal === "object"
      ? snapshot.commentTraversal as Record<string, unknown> : {};
    const declaredTotal = nullableMetric(traversal.declaredTotal);
    const retainedTopLevelIds = observedComments
      .filter((comment) => comment.isReply !== true && stringValue(comment.evidenceLocalId))
      .map((comment) => stringValue(comment.evidenceLocalId));
    const fetchedTotal = nullableMetric(traversal.fetchedTotal) ?? observedComments.length;
    const seenButFilteredCount = Math.max(0, fetchedTotal - observedComments.length);
    const filteredEvidenceIds = Array.from({ length: seenButFilteredCount }, (_, index) => `filtered-comment-${digest(`${noteId}|${detail.collectedAt}|${index}`).slice(0, 20)}`);
    const capturedTopLevelIds = [...retainedTopLevelIds, ...filteredEvidenceIds];
    const topLevelByAuthor = new Map(observedComments
      .filter((comment) => comment.isReply !== true && stringValue(comment.evidenceLocalId) && stringValue(comment.author))
      .map((comment) => [stringValue(comment.author), stringValue(comment.evidenceLocalId)]));
    const replyGroups = new Map<string, string[]>();
    for (const comment of observedComments.filter((item) => item.isReply === true && stringValue(item.evidenceLocalId))) {
      const replyTo = stringValue(comment.replyTo);
      const parentCommentId = topLevelByAuthor.get(replyTo)
        ?? `visible-reply-parent-${digest(`${noteId}|${replyTo || "unresolved"}`).slice(0, 20)}`;
      replyGroups.set(parentCommentId, [...(replyGroups.get(parentCommentId) ?? []), stringValue(comment.evidenceLocalId)]);
    }
    const replyThreads = [...replyGroups.entries()].map(([parentCommentId, capturedReplyIds]) => ({
      parentCommentId,
      declaredReplyCount: null,
      capturedReplyIds,
      expansionExhausted: traversal.complete === true,
    }));
    const previous = await store.getCompletenessLedger(noteId);
    if (!previous || Date.parse(detail.collectedAt) > Date.parse(previous.updatedAt)) {
      const presentFields = [payload.title && "title", payload.body && "body", payload.authorName && "author", Object.values(payload.metrics).some((value) => value !== null) && "metrics", snapshot.assetExtractionSucceeded === true && payload.assets.length > 0 && "assets"].filter(Boolean) as string[];
      await ranking.recordCompleteness({
        noteId,
        observedAt: detail.collectedAt,
        detail: { access: "VISIBLE", requiredFields: ["title", "body", "author", "metrics", "assets"], presentFields, evidenceEnvelopeIds: [detail.envelopeId] },
        comments: { access: "VISIBLE", platformDeclaredTotal: declaredTotal, capturedTopLevelIds, replyThreads, topLevelPaginationExhausted: traversal.complete === true, nextCursor: null, evidenceEnvelopeIds: [comments.envelopeId] },
      });
    } else gaps.push("COMPLETENESS_OBSERVATION_NOT_NEWER");
    const search = latestMatchingSearch(all, noteId);
    if (search) {
      const note = normalizeNote({ keyword: search.keyword, card: search.card, searchEnvelope: search.envelope, detailEnvelope: detail });
      await store.upsertNotes([note]);
      await store.saveQuality([evaluateNote(note, input.ingestedAt ?? new Date().toISOString())]);
      normalizedNoteIds.push(note.noteId);
    } else gaps.push("MATCHING_SEARCH_EVIDENCE_REQUIRED_FOR_NORMALIZATION");
  }

  const uniqueGaps = [...new Set(gaps)].sort();
  const status = normalizedNoteIds.length === 0 ? "RAW_PERSISTED" : uniqueGaps.length ? "NORMALIZED_WITH_GAPS" : "NORMALIZED";
  return {
    receiptId: receipt.receiptId,
    status,
    envelopeIds: built.map((item) => item.envelopeId),
    normalizedNoteIds: [...new Set(normalizedNoteIds)].sort(),
    rankingSnapshotIds,
    enrichmentPlanIds,
    enrichmentTargets,
    gaps: uniqueGaps,
    databasePath: input.databasePath,
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
  };
  } finally {
    if (store instanceof SqliteEvidenceStore) store.close();
  }
}
