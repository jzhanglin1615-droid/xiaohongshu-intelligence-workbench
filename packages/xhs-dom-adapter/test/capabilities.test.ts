import assert from "node:assert/strict";
import test from "node:test";
import {
  XHS_ADAPTER_CAPABILITY_MANIFEST,
  createQuarantinedEvidence,
  validateFallbackEvidenceInput,
} from "../src/capabilities.ts";

const manualInput = {
  kind: "MANUAL_TEXT" as const,
  sourceUrl: "https://example.invalid/note/manual-001",
  capturedAt: "2026-09-24T03:00:00.000Z",
  suppliedBy: "USER" as const,
  completeness: "PARTIAL" as const,
  limitations: ["Comments were not included."],
  content: "User-supplied note text.",
};

test("capability manifest separates offline proof from real-platform proof", () => {
  assert.equal(XHS_ADAPTER_CAPABILITY_MANIFEST.verification.offlineContract, "PASS");
  assert.equal(XHS_ADAPTER_CAPABILITY_MANIFEST.verification.realPlatformConnection, "NOT_STARTED");
  assert.equal(XHS_ADAPTER_CAPABILITY_MANIFEST.verification.humanFieldComparison, "NOT_STARTED");
});

test("capability manifest rejects risky collection shortcuts", () => {
  assert.deepEqual(XHS_ADAPTER_CAPABILITY_MANIFEST.prohibitedBehaviors, [
    "DIRECT_HTTP_WITH_ACCOUNT_COOKIE",
    "INTERACTIVE_CLICK_OR_INPUT",
    "ANTI_BOT_BYPASS",
    "AUTOMATIC_MEDIA_DOWNLOAD",
    "AUTOMATIC_REMOTE_SYNC",
  ]);
});

test("manual fallback is fingerprinted and quarantined instead of masquerading as live capture", () => {
  const first = createQuarantinedEvidence(manualInput);
  const second = createQuarantinedEvidence({ ...manualInput, capturedAt: "2026-09-24T04:00:00.000Z" });
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.equal(first.ingestionStatus, "QUARANTINED_PENDING_MAPPING");
  assert.equal(first.inputKind, "MANUAL_TEXT");
  assert.match(first.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test("structured JSON fingerprints are stable across object key order", () => {
  const base = {
    kind: "STRUCTURED_JSON" as const,
    sourceUrl: "https://example.invalid/note/json-001",
    capturedAt: "2026-09-24T03:00:00.000Z",
    suppliedBy: "USER" as const,
    completeness: "USER_ASSERTED_COMPLETE" as const,
    limitations: [],
  };
  const first = createQuarantinedEvidence({ ...base, data: { title: "A", metrics: { likes: 1, comments: 2 } } });
  const second = createQuarantinedEvidence({ ...base, data: { metrics: { comments: 2, likes: 1 }, title: "A" } });
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
});

test("empty manual input fails before an evidence record is created", () => {
  const invalid = { ...manualInput, content: "" };
  const validation = validateFallbackEvidenceInput(invalid);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /content is required/);
  assert.throws(() => createQuarantinedEvidence(invalid), /validation failed/);
});
