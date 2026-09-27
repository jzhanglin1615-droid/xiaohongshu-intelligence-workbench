import { createHash } from "node:crypto";

export type CaptureInputKind =
  | "VISIBLE_PAGE_OBSERVATION"
  | "STRUCTURED_JSON"
  | "MANUAL_TEXT";

export type CapabilityStatus =
  | "IMPLEMENTED_OFFLINE_CONTRACT"
  | "CONTRACT_ONLY"
  | "NOT_SUPPORTED";

export interface CaptureCapability {
  kind: CaptureInputKind;
  status: CapabilityStatus;
  output: "RAW_ENVELOPE" | "QUARANTINED_EVIDENCE";
  limitations: string[];
}

export interface AdapterCapabilityManifest {
  manifestVersion: "1.0.0";
  adapterId: "xhs-dom-adapter";
  platform: "XIAOHONGSHU";
  captureCapabilities: CaptureCapability[];
  verification: {
    offlineContract: "PASS";
    realPlatformConnection: "NOT_STARTED";
    humanFieldComparison: "NOT_STARTED";
  };
  prohibitedBehaviors: string[];
}

export const XHS_ADAPTER_CAPABILITY_MANIFEST: AdapterCapabilityManifest = {
  manifestVersion: "1.0.0",
  adapterId: "xhs-dom-adapter",
  platform: "XIAOHONGSHU",
  captureCapabilities: [
    {
      kind: "VISIBLE_PAGE_OBSERVATION",
      status: "IMPLEMENTED_OFFLINE_CONTRACT",
      output: "RAW_ENVELOPE",
      limitations: [
        "The browser bridge is not connected to the real platform.",
        "Only the currently visible page may be observed.",
      ],
    },
    {
      kind: "STRUCTURED_JSON",
      status: "CONTRACT_ONLY",
      output: "QUARANTINED_EVIDENCE",
      limitations: [
        "User-supplied JSON is untrusted evidence.",
        "It cannot enter normalization until a reviewed mapping is recorded.",
      ],
    },
    {
      kind: "MANUAL_TEXT",
      status: "CONTRACT_ONLY",
      output: "QUARANTINED_EVIDENCE",
      limitations: [
        "Manual text may omit fields or context.",
        "It must never be labelled as live page capture.",
      ],
    },
  ],
  verification: {
    offlineContract: "PASS",
    realPlatformConnection: "NOT_STARTED",
    humanFieldComparison: "NOT_STARTED",
  },
  prohibitedBehaviors: [
    "DIRECT_HTTP_WITH_ACCOUNT_COOKIE",
    "INTERACTIVE_CLICK_OR_INPUT",
    "ANTI_BOT_BYPASS",
    "AUTOMATIC_MEDIA_DOWNLOAD",
    "AUTOMATIC_REMOTE_SYNC",
  ],
};

interface EvidenceInputBase {
  sourceUrl: string;
  capturedAt: string;
  suppliedBy: "USER";
  limitations: string[];
}

export interface ManualTextEvidenceInput extends EvidenceInputBase {
  kind: "MANUAL_TEXT";
  content: string;
  completeness: "PARTIAL" | "USER_ASSERTED_COMPLETE";
}

export interface StructuredJsonEvidenceInput extends EvidenceInputBase {
  kind: "STRUCTURED_JSON";
  data: unknown;
  completeness: "PARTIAL" | "USER_ASSERTED_COMPLETE";
}

export type FallbackEvidenceInput = ManualTextEvidenceInput | StructuredJsonEvidenceInput;

export interface QuarantinedEvidenceRecord {
  recordVersion: "1.0.0";
  recordId: string;
  sourceFingerprint: string;
  inputKind: FallbackEvidenceInput["kind"];
  sourceUrl: string;
  capturedAt: string;
  suppliedBy: "USER";
  claimedCompleteness: FallbackEvidenceInput["completeness"];
  limitations: string[];
  ingestionStatus: "QUARANTINED_PENDING_MAPPING";
  content: string | unknown;
}

export interface EvidenceInputValidationResult {
  ok: boolean;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function validateFallbackEvidenceInput(value: unknown): EvidenceInputValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["input must be an object"] };
  if (value.kind !== "MANUAL_TEXT" && value.kind !== "STRUCTURED_JSON") {
    errors.push("kind must be MANUAL_TEXT or STRUCTURED_JSON");
  }
  if (!isNonEmptyString(value.sourceUrl)) errors.push("sourceUrl is required");
  if (!isNonEmptyString(value.capturedAt) || Number.isNaN(Date.parse(String(value.capturedAt)))) {
    errors.push("capturedAt must be an ISO-compatible timestamp");
  }
  if (value.suppliedBy !== "USER") errors.push("suppliedBy must be USER");
  if (value.completeness !== "PARTIAL" && value.completeness !== "USER_ASSERTED_COMPLETE") {
    errors.push("completeness is invalid");
  }
  if (!Array.isArray(value.limitations) || !value.limitations.every(isNonEmptyString)) {
    errors.push("limitations must be an array of non-empty strings");
  }
  if (value.kind === "MANUAL_TEXT" && !isNonEmptyString(value.content)) {
    errors.push("content is required for MANUAL_TEXT");
  }
  if (value.kind === "STRUCTURED_JSON" && !("data" in value)) {
    errors.push("data is required for STRUCTURED_JSON");
  }
  return { ok: errors.length === 0, errors };
}

export function createQuarantinedEvidence(input: FallbackEvidenceInput): QuarantinedEvidenceRecord {
  const validation = validateFallbackEvidenceInput(input);
  if (!validation.ok) throw new Error(`Fallback evidence validation failed: ${validation.errors.join("; ")}`);
  const content = input.kind === "MANUAL_TEXT" ? input.content : input.data;
  const sourceFingerprint = createHash("sha256")
    .update(stableJson({
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      content,
    }), "utf8")
    .digest("hex");
  return {
    recordVersion: "1.0.0",
    recordId: `evidence-${sourceFingerprint.slice(0, 16)}`,
    sourceFingerprint,
    inputKind: input.kind,
    sourceUrl: input.sourceUrl,
    capturedAt: input.capturedAt,
    suppliedBy: input.suppliedBy,
    claimedCompleteness: input.completeness,
    limitations: [...input.limitations],
    ingestionStatus: "QUARANTINED_PENDING_MAPPING",
    content,
  };
}
