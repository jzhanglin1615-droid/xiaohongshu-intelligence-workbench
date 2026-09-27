export const BROWSER_PROTOCOL_VERSION = "1.0.0" as const;

export type BrowserPageType = "SEARCH" | "NOTE_DETAIL";
export type BrowserPageStatus = "VISIBLE" | "HUMAN_REQUIRED" | "UNKNOWN_STRUCTURE";

export interface CaptureVisiblePageRequest {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "CAPTURE_VISIBLE_PAGE";
  correlationId: string;
  taskId: string;
  expectedPageType: BrowserPageType;
  issuedAt: string;
  readOnly: true;
  authorization: {
    readVisiblePages: true;
    interactiveActions: false;
  };
}

export interface PageSnapshotMessage {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "PAGE_SNAPSHOT";
  correlationId: string;
  snapshot: {
    sourceUrl: string;
    capturedAt: string;
    pageType: BrowserPageType;
    status: BrowserPageStatus;
    html: string;
    snapshotPath: string;
  };
}

export interface BrowserCaptureErrorMessage {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: "CAPTURE_ERROR";
  correlationId: string;
  category: "RETRYABLE" | "NEEDS_HUMAN" | "PERMANENT" | "POLICY_BLOCKED";
  code: string;
  message: string;
}

export type BrowserMessage =
  | CaptureVisiblePageRequest
  | PageSnapshotMessage
  | BrowserCaptureErrorMessage;

export interface BrowserMessageValidationResult {
  ok: boolean;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

export const ALLOWED_BROWSER_COMMANDS = ["CAPTURE_VISIBLE_PAGE"] as const;

export function validateBrowserMessage(value: unknown): BrowserMessageValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["message must be an object"] };
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must equal ${BROWSER_PROTOCOL_VERSION}`);
  }
  if (!isNonEmptyString(value.correlationId)) errors.push("correlationId is required");

  if (value.kind === "CAPTURE_VISIBLE_PAGE") {
    if (!isNonEmptyString(value.taskId)) errors.push("taskId is required");
    if (value.expectedPageType !== "SEARCH" && value.expectedPageType !== "NOTE_DETAIL") {
      errors.push("expectedPageType is invalid");
    }
    if (!isTimestamp(value.issuedAt)) errors.push("issuedAt must be an ISO-compatible timestamp");
    if (value.readOnly !== true) errors.push("readOnly must be true");
    if (!isRecord(value.authorization)) {
      errors.push("authorization is required");
    } else {
      if (value.authorization.readVisiblePages !== true) {
        errors.push("authorization.readVisiblePages must be true");
      }
      if (value.authorization.interactiveActions !== false) {
        errors.push("authorization.interactiveActions must be false");
      }
    }
  } else if (value.kind === "PAGE_SNAPSHOT") {
    if (!isRecord(value.snapshot)) {
      errors.push("snapshot is required");
    } else {
      if (!isNonEmptyString(value.snapshot.sourceUrl)) errors.push("snapshot.sourceUrl is required");
      if (!isTimestamp(value.snapshot.capturedAt)) errors.push("snapshot.capturedAt is invalid");
      if (value.snapshot.pageType !== "SEARCH" && value.snapshot.pageType !== "NOTE_DETAIL") {
        errors.push("snapshot.pageType is invalid");
      }
      if (!['VISIBLE', 'HUMAN_REQUIRED', 'UNKNOWN_STRUCTURE'].includes(String(value.snapshot.status))) {
        errors.push("snapshot.status is invalid");
      }
      if (typeof value.snapshot.html !== "string") errors.push("snapshot.html must be a string");
      if (!isNonEmptyString(value.snapshot.snapshotPath)) errors.push("snapshot.snapshotPath is required");
    }
  } else if (value.kind === "CAPTURE_ERROR") {
    if (!['RETRYABLE', 'NEEDS_HUMAN', 'PERMANENT', 'POLICY_BLOCKED'].includes(String(value.category))) {
      errors.push("category is invalid");
    }
    if (!isNonEmptyString(value.code)) errors.push("code is required");
    if (!isNonEmptyString(value.message)) errors.push("message is required");
  } else {
    errors.push("kind is not allowed by the read-only browser protocol");
  }

  return { ok: errors.length === 0, errors };
}

export class BrowserProtocolValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Browser message validation failed: ${errors.join("; ")}`);
    this.name = "BrowserProtocolValidationError";
    this.errors = errors;
  }
}

export function assertBrowserMessage(value: unknown): asserts value is BrowserMessage {
  const result = validateBrowserMessage(value);
  if (!result.ok) throw new BrowserProtocolValidationError(result.errors);
}
