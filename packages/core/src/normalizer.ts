import {
  CONTRACT_VERSION,
  type CanonicalAsset,
  type CanonicalNote,
  type RawEnvelope,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "./errors.ts";

export interface SearchCardPayload {
  noteId: string;
  title: string;
  authorId: string;
  authorName: string;
  sourceUrl: string;
  coverUrl?: string | null;
  likes: number | null;
  collects?: number | null;
  shares?: number | null;
  mediaType?: "VIDEO" | "IMAGE" | "UNKNOWN";
}

export interface SearchResultsPayload {
  keyword: string;
  cards: SearchCardPayload[];
}

export interface NoteDetailPayload {
  noteId: string;
  title: string;
  body: string | null;
  authorId: string;
  authorName: string;
  sourceUrl: string;
  metrics: {
    likes: number | null;
    collects: number | null;
    comments: number | null;
    shares?: number | null;
  };
  expectedAssetCount: number | null;
  assets: Array<{
    type: "IMAGE" | "VIDEO" | "VIDEO_COVER";
    ordinal: number;
    sourceUrl: string;
  }>;
}

function asSearchPayload(envelope: RawEnvelope): SearchResultsPayload {
  if (envelope.kind !== "SEARCH_RESULTS" || typeof envelope.payload !== "object" || envelope.payload === null) {
    throw new WorkbenchError({
      category: "PERMANENT",
      code: "INVALID_SEARCH_PAYLOAD",
      message: "Search envelope payload is not valid.",
      targetId: envelope.envelopeId,
    });
  }
  return envelope.payload as SearchResultsPayload;
}

function asDetailPayload(envelope: RawEnvelope): NoteDetailPayload {
  if (envelope.kind !== "NOTE_DETAIL" || typeof envelope.payload !== "object" || envelope.payload === null) {
    throw new WorkbenchError({
      category: "PERMANENT",
      code: "INVALID_DETAIL_PAYLOAD",
      message: "Detail envelope payload is not valid.",
      targetId: envelope.envelopeId,
    });
  }
  return envelope.payload as NoteDetailPayload;
}

export function listSearchCards(envelope: RawEnvelope): SearchCardPayload[] {
  const payload = asSearchPayload(envelope);
  if (!Array.isArray(payload.cards)) {
    throw new WorkbenchError({
      category: "PERMANENT",
      code: "SEARCH_CARDS_MISSING",
      message: "Search payload does not contain cards.",
      targetId: envelope.envelopeId,
    });
  }
  return payload.cards;
}

export function normalizeNote(input: {
  keyword: string;
  card: SearchCardPayload;
  searchEnvelope: RawEnvelope;
  detailEnvelope: RawEnvelope;
}): CanonicalNote {
  const detail = asDetailPayload(input.detailEnvelope);
  if (input.card.noteId !== detail.noteId) {
    throw new WorkbenchError({
      category: "PERMANENT",
      code: "NOTE_ID_MISMATCH",
      message: `Search card ${input.card.noteId} does not match detail ${detail.noteId}.`,
      targetId: input.card.noteId,
    });
  }

  const assets: CanonicalAsset[] = (detail.assets ?? []).map((asset) => ({
    assetId: `${detail.noteId}:${asset.ordinal}`,
    type: asset.type,
    ordinal: asset.ordinal,
    sourceUrl: asset.sourceUrl,
    localPath: null,
    sha256: null,
    rightsStatus: "REFERENCE_ONLY",
  }));
  const assetCountMatches = detail.expectedAssetCount === null || detail.expectedAssetCount === assets.length;
  const bodyComplete = typeof detail.body === "string" && detail.body.trim().length > 0;

  return {
    schemaVersion: CONTRACT_VERSION,
    noteId: detail.noteId,
    title: detail.title || input.card.title,
    body: detail.body,
    author: {
      authorId: detail.authorId || input.card.authorId,
      displayName: detail.authorName || input.card.authorName,
    },
    metrics: {
      likes: detail.metrics?.likes ?? input.card.likes ?? null,
      collects: detail.metrics?.collects ?? input.card.collects ?? null,
      comments: detail.metrics?.comments ?? null,
      shares: detail.metrics?.shares ?? input.card.shares ?? null,
      observedAt: input.detailEnvelope.collectedAt,
    },
    assets,
    expectedAssetCount: detail.expectedAssetCount,
    keywords: [input.keyword],
    detailStatus: bodyComplete && assetCountMatches ? "COMPLETE" : "INCOMPLETE",
    provenance: {
      sourceUrls: [...new Set([input.card.sourceUrl, detail.sourceUrl])],
      envelopeIds: [input.searchEnvelope.envelopeId, input.detailEnvelope.envelopeId],
      parserVersions: [...new Set([input.searchEnvelope.parserVersion, input.detailEnvelope.parserVersion])],
      collectedAt: [input.searchEnvelope.collectedAt, input.detailEnvelope.collectedAt],
    },
  };
}

export function mergeCanonicalNotes(existing: CanonicalNote, incoming: CanonicalNote): CanonicalNote {
  if (existing.noteId !== incoming.noteId) throw new Error("Cannot merge notes with different IDs.");
  const incomingIsNewer = Date.parse(incoming.metrics.observedAt) >= Date.parse(existing.metrics.observedAt);
  const latest = incomingIsNewer ? incoming : existing;
  return {
    ...latest,
    keywords: [...new Set([...existing.keywords, ...incoming.keywords])],
    provenance: {
      sourceUrls: [...new Set([...existing.provenance.sourceUrls, ...incoming.provenance.sourceUrls])],
      envelopeIds: [...new Set([...existing.provenance.envelopeIds, ...incoming.provenance.envelopeIds])],
      parserVersions: [...new Set([...existing.provenance.parserVersions, ...incoming.provenance.parserVersions])],
      collectedAt: [...new Set([...existing.provenance.collectedAt, ...incoming.provenance.collectedAt])],
    },
  };
}
