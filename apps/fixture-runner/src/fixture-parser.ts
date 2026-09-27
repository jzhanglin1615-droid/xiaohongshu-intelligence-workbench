import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  assertContract,
  type CollectionRunTarget,
  type RawEnvelope,
  type RankingSnapshot,
} from "../../../packages/contracts/src/index.ts";
import { WorkbenchError } from "../../../packages/core/src/errors.ts";
import { listSearchCards, normalizeNote, type NoteDetailPayload } from "../../../packages/core/src/normalizer.ts";
import type { CollectionTargetCollector, CollectionTargetResult, PlatformCollector } from "../../../packages/core/src/ports.ts";

interface FixtureDocument {
  kind: "SEARCH_RESULTS" | "NOTE_DETAIL" | "COMMENT_PAGE";
  sourceUrl: string;
  collectedAt: string;
  data: unknown;
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function parseFixture(filePath: string): Promise<RawEnvelope> {
  const absolutePath = path.resolve(filePath);
  const html = await readFile(absolutePath, "utf8");
  const match = html.match(/<script\s+id=["']xhs-fixture["']\s+type=["']application\/json["']\s*>([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new WorkbenchError({
      category: "PERMANENT",
      code: "FIXTURE_CONTRACT_MISSING",
      message: `Fixture ${absolutePath} does not contain the xhs-fixture contract script.`,
      targetId: absolutePath,
    });
  }
  const fixture = JSON.parse(match[1]) as FixtureDocument;
  const contentHash = hash(html);
  const envelope: RawEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    envelopeId: `${fixture.kind.toLowerCase()}-${contentHash.slice(0, 16)}`,
    kind: fixture.kind,
    sourceUrl: fixture.sourceUrl,
    collectedAt: fixture.collectedAt,
    parserVersion: "fixture-parser/1.0.0",
    payload: fixture.data,
    evidence: {
      fixturePath: absolutePath,
      sha256: contentHash,
    },
  };
  assertContract<RawEnvelope>("RawEnvelope", envelope);
  return envelope;
}

interface CommentFixturePayload {
  noteId: string;
  platformDeclaredTotal: number;
  topLevelPaginationExhausted: boolean;
  nextCursor: string | null;
  comments: Array<{
    commentId: string;
    declaredReplyCount: number;
    expansionExhausted: boolean;
    replies: Array<{ commentId: string }>;
  }>;
}

export class FixtureCollector implements PlatformCollector, CollectionTargetCollector {
  private readonly fixtureRoot: string;

  constructor(fixtureRoot: string) {
    this.fixtureRoot = path.resolve(fixtureRoot);
  }

  async collectSearch(keyword: string, _limit: number): Promise<RawEnvelope> {
    if (keyword !== "AI工具") {
      throw new WorkbenchError({
        category: "PERMANENT",
        code: "SEARCH_FIXTURE_NOT_FOUND",
        message: `No offline search fixture exists for keyword: ${keyword}`,
        targetId: keyword,
      });
    }
    return parseFixture(path.join(this.fixtureRoot, "search", "seed-ai-tools.html"));
  }

  async collectNote(noteId: string): Promise<RawEnvelope> {
    if (!/^note-00[1-3]$/.test(noteId)) {
      throw new WorkbenchError({
        category: "PERMANENT",
        code: "DETAIL_FIXTURE_NOT_FOUND",
        message: `No offline detail fixture exists for note: ${noteId}`,
        targetId: noteId,
      });
    }
    return parseFixture(path.join(this.fixtureRoot, "details", `${noteId}.html`));
  }

  async collectComments(noteId: string): Promise<RawEnvelope> {
    if (!/^note-00[1-3]$/.test(noteId)) {
      throw new WorkbenchError({
        category: "PERMANENT",
        code: "COMMENT_FIXTURE_NOT_FOUND",
        message: `No offline comment fixture exists for note: ${noteId}`,
        targetId: noteId,
      });
    }
    return parseFixture(path.join(this.fixtureRoot, "comments", `${noteId}.html`));
  }

  async collectTarget(target: CollectionRunTarget): Promise<CollectionTargetResult> {
    if (target.stage === "KEYWORD_SEARCH") {
      const envelope = await this.collectSearch(target.query ?? "", 20);
      return { envelopes: [envelope] };
    }

    if (target.stage === "RANKING_SNAPSHOT") {
      const envelope = await this.collectSearch("AI工具", 20);
      const cards = listSearchCards(envelope);
      const snapshot: RankingSnapshot = {
        schemaVersion: CONTRACT_VERSION,
        snapshotId: `ranking-${target.scopeId}-${envelope.envelopeId}`,
        scopeId: target.scopeId!,
        scopeLabel: target.scopeId!,
        coverage: "COMPLETE",
        expectedSlots: cards.length,
        entries: cards.map((card, index) => ({
          noteId: card.noteId,
          rank: index + 1,
          sourceEnvelopeId: envelope.envelopeId,
        })),
        observedAt: envelope.collectedAt,
      };
      return { envelopes: [envelope], rankingSnapshot: snapshot };
    }

    if (target.stage === "DETAIL") {
      const searchEnvelope = await this.collectSearch("AI工具", 20);
      const detailEnvelope = await this.collectNote(target.noteId!);
      const card = listSearchCards(searchEnvelope).find((item) => item.noteId === target.noteId);
      if (!card) throw new Error(`Detail target ${target.noteId} is absent from the search fixture.`);
      const payload = detailEnvelope.payload as NoteDetailPayload;
      const presentFields = [
        payload.title ? "title" : null,
        payload.body ? "body" : null,
        payload.authorId && payload.authorName ? "author" : null,
        payload.metrics ? "metrics" : null,
        Array.isArray(payload.assets) ? "assets" : null,
      ].filter(Boolean) as string[];
      return {
        envelopes: [searchEnvelope, detailEnvelope],
        detailObservation: {
          noteId: target.noteId!,
          observedAt: detailEnvelope.collectedAt,
          access: "VISIBLE",
          requiredFields: ["title", "body", "author", "metrics", "assets"],
          presentFields,
          evidenceEnvelopeIds: [detailEnvelope.envelopeId],
        },
        canonicalNotes: [normalizeNote({ keyword: "AI工具", card, searchEnvelope, detailEnvelope })],
      };
    }

    const envelope = await this.collectComments(target.noteId!);
    const payload = envelope.payload as CommentFixturePayload;
    return {
      envelopes: [envelope],
      commentsObservation: {
        noteId: payload.noteId,
        observedAt: envelope.collectedAt,
        access: "VISIBLE",
        platformDeclaredTotal: payload.platformDeclaredTotal,
        capturedTopLevelIds: payload.comments.map((comment) => comment.commentId),
        replyThreads: payload.comments.map((comment) => ({
          parentCommentId: comment.commentId,
          declaredReplyCount: comment.declaredReplyCount,
          capturedReplyIds: comment.replies.map((reply) => reply.commentId),
          expansionExhausted: comment.expansionExhausted,
        })),
        topLevelPaginationExhausted: payload.topLevelPaginationExhausted,
        nextCursor: payload.nextCursor,
        evidenceEnvelopeIds: [envelope.envelopeId],
      },
    };
  }
}
