import { createHash } from "node:crypto";

const verdicts = new Set(["MATCH", "MISMATCH", "NOT_OBSERVABLE"]);
const text = (value, maximum = 500) => String(value ?? "").trim().slice(0, maximum);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sanitizeVisiblePageUrl(value) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { throw new Error("INVALID_OBSERVED_SOURCE_URL"); }
  if (url.protocol !== "https:" || !/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) throw new Error("INVALID_OBSERVED_SOURCE_URL");
  return `${url.origin}${url.pathname}`;
}

export function createBrowserHumanComparison(fieldValidation, input = {}, options = {}) {
  if (fieldValidation?.evidenceClass !== "REAL_VISIBLE_PAGE") throw new Error("HUMAN_COMPARISON_REQUIRES_REAL_VISIBLE_PAGE");
  const fieldValidationReceiptId = text(fieldValidation?.receiptId, 160);
  const fieldValidationSha256 = text(fieldValidation?.sha256, 64);
  if (!fieldValidationReceiptId || !/^[a-f0-9]{64}$/i.test(fieldValidationSha256)) throw new Error("INVALID_FIELD_VALIDATION_RECEIPT");
  if (input.comparisonBasis !== "SIDE_BY_SIDE_VISIBLE_PAGE") throw new Error("SIDE_BY_SIDE_VISIBLE_PAGE_REQUIRED");
  if (input.confirmedVisiblePage !== true) throw new Error("VISIBLE_PAGE_CONFIRMATION_REQUIRED");
  const observedSourcePath = sanitizeVisiblePageUrl(input.observedSourceUrl);
  if (!fieldValidation.sourcePath || observedSourcePath !== fieldValidation.sourcePath) throw new Error("OBSERVED_SOURCE_PATH_MISMATCH");

  const expectedFields = Array.isArray(fieldValidation.fields) ? fieldValidation.fields : [];
  if (expectedFields.length === 0) throw new Error("FIELD_VALIDATION_HAS_NO_FIELDS");
  const submitted = Array.isArray(input.verdicts) ? input.verdicts : [];
  const byKey = new Map();
  for (const item of submitted) {
    const key = text(item?.key, 160);
    if (!key || byKey.has(key)) throw new Error("DUPLICATE_OR_EMPTY_FIELD_VERDICT");
    const verdict = text(item?.verdict, 32);
    if (!verdicts.has(verdict)) throw new Error("INVALID_FIELD_VERDICT");
    byKey.set(key, { verdict, note: text(item?.note, 500) || null });
  }
  if (byKey.size !== expectedFields.length || expectedFields.some((field) => !byKey.has(field.key)) || [...byKey.keys()].some((key) => !expectedFields.some((field) => field.key === key))) {
    throw new Error("EVERY_FIELD_REQUIRES_EXACTLY_ONE_VERDICT");
  }

  const fields = expectedFields.map((field) => {
    const submittedVerdict = byKey.get(field.key);
    if (!field.present && submittedVerdict.verdict === "MATCH") throw new Error("MISSING_MACHINE_FIELD_CANNOT_MATCH");
    return {
      key: field.key,
      section: field.section,
      required: Boolean(field.required),
      machinePresent: Boolean(field.present),
      verdict: submittedVerdict.verdict,
      note: submittedVerdict.note,
    };
  });
  const summary = {
    totalFields: fields.length,
    matches: fields.filter((field) => field.verdict === "MATCH").length,
    mismatches: fields.filter((field) => field.verdict === "MISMATCH").length,
    notObservable: fields.filter((field) => field.verdict === "NOT_OBSERVABLE").length,
  };
  const humanComparisonStatus = summary.mismatches > 0
    ? "FAIL"
    : fieldValidation.machineCoverageStatus === "COMPLETE" && summary.matches === summary.totalFields
      ? "PASS"
      : "INCOMPLETE";
  const createdAt = options.createdAt ?? new Date().toISOString();
  const base = {
    schemaVersion: "1.0.0",
    comparisonId: "",
    fieldValidationReceiptId,
    fieldValidationSha256,
    snapshotFingerprint: text(fieldValidation.snapshotFingerprint, 64),
    pageType: fieldValidation.pageType,
    evidenceClass: "REAL_VISIBLE_PAGE",
    comparisonBasis: "SIDE_BY_SIDE_VISIBLE_PAGE",
    confirmedVisiblePage: true,
    observedSourcePath,
    reviewer: text(input.reviewer, 120) || "LOCAL_OPERATOR",
    createdAt,
    machineCoverageStatus: fieldValidation.machineCoverageStatus,
    humanComparisonStatus,
    summary,
    fields,
    boundaries: [
      "MACHINE_COVERAGE_DOES_NOT_PROVE_VALUE_CORRECTNESS",
      "COMPARISON_IS_BOUND_TO_ONE_FIELD_VALIDATION_HASH",
      "CONTRACT_FIXTURES_CANNOT_RECEIVE_HUMAN_PLATFORM_APPROVAL",
      "RECEIPT_IS_APPEND_ONLY",
    ],
  };
  const identityHash = digest(base);
  base.comparisonId = `human-${Date.parse(createdAt) || Date.now()}-${identityHash.slice(0, 10)}`;
  return { ...base, sha256: digest(base) };
}

export function verifyBrowserHumanComparison(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const { sha256, ...base } = receipt;
  return typeof sha256 === "string" && /^[a-f0-9]{64}$/i.test(sha256) && digest(base) === sha256;
}
