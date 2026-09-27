import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContract,
  type RawEnvelope,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "../../core/src/errors.ts";
import type { PlatformCollector } from "../../core/src/ports.ts";
import type {
  NoteDetailPayload,
  SearchCardPayload,
  SearchResultsPayload,
} from "../../core/src/normalizer.ts";
import {
  BROWSER_PROTOCOL_VERSION,
  assertBrowserMessage,
  type BrowserCaptureErrorMessage,
  type BrowserPageType,
  type CaptureVisiblePageRequest,
  type PageSnapshotMessage,
} from "./protocol.ts";

export const XHS_DOM_PARSER_VERSION = "xhs-dom-adapter/0.1.0" as const;

interface DomObservationDocument {
  schemaVersion: "1.0.0";
  pageType: BrowserPageType;
  data: unknown;
}

export interface BrowserTransport {
  capture(request: CaptureVisiblePageRequest): Promise<PageSnapshotMessage | BrowserCaptureErrorMessage>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isNullableMetric = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function fail(input: {
  code: string;
  message: string;
  targetId: string;
  category?: "RETRYABLE" | "NEEDS_HUMAN" | "PERMANENT" | "POLICY_BLOCKED";
}): never {
  throw new WorkbenchError({
    category: input.category ?? "PERMANENT",
    code: input.code,
    message: input.message,
    targetId: input.targetId,
  });
}

function extractObservation(html: string, targetId: string): DomObservationDocument {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const attributes = match[1];
    const hasId = /\bid\s*=\s*["']xhs-page-observation["']/i.test(attributes);
    const hasJsonType = /\btype\s*=\s*["']application\/json["']/i.test(attributes);
    if (!hasId || !hasJsonType) continue;
    try {
      const parsed = JSON.parse(match[2]) as unknown;
      if (!isRecord(parsed)) fail({ code: "DOM_OBSERVATION_INVALID", message: "DOM observation must be an object.", targetId });
      if (parsed.schemaVersion !== "1.0.0") {
        fail({ code: "DOM_OBSERVATION_VERSION_UNSUPPORTED", message: "DOM observation schema version is unsupported.", targetId });
      }
      if (parsed.pageType !== "SEARCH" && parsed.pageType !== "NOTE_DETAIL") {
        fail({ code: "DOM_PAGE_TYPE_UNKNOWN", message: "DOM observation page type is unknown.", targetId });
      }
      return parsed as unknown as DomObservationDocument;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      fail({
        code: "DOM_OBSERVATION_JSON_INVALID",
        message: `DOM observation JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
        targetId,
      });
    }
  }
  fail({
    code: "DOM_STRUCTURE_UNKNOWN",
    message: "The visible page does not match the versioned DOM observation contract.",
    targetId,
  });
}

function validateSearchCard(value: unknown, index: number, targetId: string): asserts value is SearchCardPayload {
  if (!isRecord(value)) fail({ code: "DOM_SEARCH_CARD_INVALID", message: `Search card ${index} must be an object.`, targetId });
  for (const field of ["noteId", "title", "authorId", "authorName", "sourceUrl"] as const) {
    if (!isNonEmptyString(value[field])) {
      fail({ code: "DOM_SEARCH_CARD_FIELD_MISSING", message: `Search card ${index} is missing ${field}.`, targetId });
    }
  }
  if (!isNullableMetric(value.likes)) {
    fail({ code: "DOM_SEARCH_CARD_METRIC_INVALID", message: `Search card ${index} has an invalid likes value.`, targetId });
  }
}

function validateSearchPayload(value: unknown, targetId: string): asserts value is SearchResultsPayload {
  if (!isRecord(value) || !isNonEmptyString(value.keyword) || !Array.isArray(value.cards)) {
    fail({ code: "DOM_SEARCH_PAYLOAD_INVALID", message: "Search payload requires keyword and cards.", targetId });
  }
  if (value.cards.length > 20) {
    fail({ code: "DOM_SEARCH_LIMIT_EXCEEDED", message: "Search payload exceeds the M1 limit of 20 cards.", targetId, category: "POLICY_BLOCKED" });
  }
  value.cards.forEach((card, index) => validateSearchCard(card, index, targetId));
}

function validateDetailPayload(value: unknown, targetId: string): asserts value is NoteDetailPayload {
  if (!isRecord(value)) fail({ code: "DOM_DETAIL_PAYLOAD_INVALID", message: "Detail payload must be an object.", targetId });
  for (const field of ["noteId", "title", "authorId", "authorName", "sourceUrl"] as const) {
    if (!isNonEmptyString(value[field])) {
      fail({ code: "DOM_DETAIL_FIELD_MISSING", message: `Detail payload is missing ${field}.`, targetId });
    }
  }
  if (value.body !== null && typeof value.body !== "string") {
    fail({ code: "DOM_DETAIL_BODY_INVALID", message: "Detail body must be a string or null.", targetId });
  }
  if (!isRecord(value.metrics) || ![value.metrics.likes, value.metrics.collects, value.metrics.comments].every(isNullableMetric)) {
    fail({ code: "DOM_DETAIL_METRICS_INVALID", message: "Detail metrics are invalid.", targetId });
  }
  if (value.expectedAssetCount !== null && (!Number.isInteger(value.expectedAssetCount) || Number(value.expectedAssetCount) < 0)) {
    fail({ code: "DOM_DETAIL_ASSET_COUNT_INVALID", message: "expectedAssetCount must be a non-negative integer or null.", targetId });
  }
  if (!Array.isArray(value.assets)) fail({ code: "DOM_DETAIL_ASSETS_INVALID", message: "Detail assets must be an array.", targetId });
  value.assets.forEach((asset, index) => {
    if (!isRecord(asset) || !["IMAGE", "VIDEO", "VIDEO_COVER"].includes(String(asset.type)) ||
      !Number.isInteger(asset.ordinal) || Number(asset.ordinal) < 1 || !isNonEmptyString(asset.sourceUrl)) {
      fail({ code: "DOM_DETAIL_ASSET_INVALID", message: `Detail asset ${index} is invalid.`, targetId });
    }
  });
}

export function parseDomSnapshot(message: PageSnapshotMessage): RawEnvelope {
  assertBrowserMessage(message);
  const { snapshot } = message;
  if (snapshot.status === "HUMAN_REQUIRED") {
    fail({
      category: "NEEDS_HUMAN",
      code: "BROWSER_HUMAN_VERIFICATION_REQUIRED",
      message: "The page requires manual login or verification; automatic bypass is forbidden.",
      targetId: snapshot.sourceUrl,
    });
  }
  if (snapshot.status === "UNKNOWN_STRUCTURE") {
    fail({
      code: "DOM_STRUCTURE_UNKNOWN",
      message: "The browser classified the page structure as unknown.",
      targetId: snapshot.sourceUrl,
    });
  }

  const observation = extractObservation(snapshot.html, snapshot.sourceUrl);
  if (observation.pageType !== snapshot.pageType) {
    fail({ code: "DOM_PAGE_TYPE_MISMATCH", message: "Snapshot and observation page types do not match.", targetId: snapshot.sourceUrl });
  }

  const kind = observation.pageType === "SEARCH" ? "SEARCH_RESULTS" : "NOTE_DETAIL";
  if (kind === "SEARCH_RESULTS") validateSearchPayload(observation.data, snapshot.sourceUrl);
  else validateDetailPayload(observation.data, snapshot.sourceUrl);

  const contentHash = hash(snapshot.html);
  const envelope: RawEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    envelopeId: `${kind.toLowerCase()}-${contentHash.slice(0, 16)}`,
    kind,
    sourceUrl: snapshot.sourceUrl,
    collectedAt: snapshot.capturedAt,
    parserVersion: XHS_DOM_PARSER_VERSION,
    payload: observation.data,
    evidence: {
      fixturePath: snapshot.snapshotPath,
      sha256: contentHash,
    },
  };
  assertContract<RawEnvelope>("RawEnvelope", envelope);
  return envelope;
}

function throwCaptureError(message: BrowserCaptureErrorMessage): never {
  throw new WorkbenchError({
    category: message.category,
    code: message.code,
    message: message.message,
    targetId: message.correlationId,
  });
}

export class XhsDomAdapter implements PlatformCollector {
  private sequence = 0;
  private readonly transport: BrowserTransport;
  private readonly taskId: string;
  private readonly now: () => string;

  constructor(
    transport: BrowserTransport,
    taskId: string,
    now: () => string,
  ) {
    this.transport = transport;
    this.taskId = taskId;
    this.now = now;
  }

  private async capture(pageType: BrowserPageType): Promise<RawEnvelope> {
    this.sequence += 1;
    const request: CaptureVisiblePageRequest = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: "CAPTURE_VISIBLE_PAGE",
      correlationId: `${this.taskId}-${this.sequence}`,
      taskId: this.taskId,
      expectedPageType: pageType,
      issuedAt: this.now(),
      readOnly: true,
      authorization: {
        readVisiblePages: true,
        interactiveActions: false,
      },
    };
    assertBrowserMessage(request);
    const response = await this.transport.capture(request);
    assertBrowserMessage(response);
    if (response.kind === "CAPTURE_ERROR") throwCaptureError(response);
    if (response.kind !== "PAGE_SNAPSHOT") {
      fail({ code: "BROWSER_RESPONSE_INVALID", message: "Browser transport returned an unexpected message.", targetId: request.correlationId });
    }
    if (response.correlationId !== request.correlationId) {
      fail({ code: "BROWSER_CORRELATION_MISMATCH", message: "Browser response correlationId does not match the request.", targetId: request.correlationId });
    }
    if (response.snapshot.pageType !== pageType) {
      fail({ code: "BROWSER_PAGE_TYPE_MISMATCH", message: "Browser returned a different page type than requested.", targetId: request.correlationId });
    }
    return parseDomSnapshot(response);
  }

  async collectSearch(keyword: string, limit: number): Promise<RawEnvelope> {
    const envelope = await this.capture("SEARCH");
    const payload = envelope.payload as SearchResultsPayload;
    if (payload.keyword !== keyword) {
      fail({ code: "SEARCH_KEYWORD_MISMATCH", message: "Visible search keyword does not match the task keyword.", targetId: keyword });
    }
    return { ...envelope, payload: { ...payload, cards: payload.cards.slice(0, limit) } };
  }

  async collectNote(noteId: string): Promise<RawEnvelope> {
    const envelope = await this.capture("NOTE_DETAIL");
    const payload = envelope.payload as NoteDetailPayload;
    if (payload.noteId !== noteId) {
      fail({ code: "NOTE_ID_MISMATCH", message: "Visible detail note does not match the requested note.", targetId: noteId });
    }
    return envelope;
  }
}
