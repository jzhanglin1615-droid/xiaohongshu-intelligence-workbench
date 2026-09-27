import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserHumanComparison, verifyBrowserHumanComparison } from "./browser-human-comparison.js";

const fields = [
  { key: "detail.title", section: "DETAIL", required: true, present: true },
  { key: "comments.visible", section: "COMMENTS", required: true, present: true },
];
const validation = {
  receiptId: "browser-1-aaaaaaaaaa", sha256: "a".repeat(64), snapshotFingerprint: "b".repeat(64),
  evidenceClass: "REAL_VISIBLE_PAGE", sourcePath: "https://www.xiaohongshu.com/explore/note-1", pageType: "NOTE_DETAIL",
  machineCoverageStatus: "COMPLETE", fields,
};
const validInput = {
  comparisonBasis: "SIDE_BY_SIDE_VISIBLE_PAGE", confirmedVisiblePage: true,
  observedSourceUrl: "https://www.xiaohongshu.com/explore/note-1?xsec_token=secret",
  verdicts: fields.map((field) => ({ key: field.key, verdict: "MATCH" })),
};

test("contract receipts can never receive a human platform approval", () => {
  assert.throws(() => createBrowserHumanComparison({ ...validation, evidenceClass: "CONTRACT_TEST" }, validInput), /HUMAN_COMPARISON_REQUIRES_REAL_VISIBLE_PAGE/);
});

test("every machine field needs exactly one human verdict", () => {
  assert.throws(() => createBrowserHumanComparison(validation, { ...validInput, verdicts: validInput.verdicts.slice(0, 1) }), /EVERY_FIELD_REQUIRES_EXACTLY_ONE_VERDICT/);
});

test("comparison is bound to the same visible source path", () => {
  assert.throws(() => createBrowserHumanComparison(validation, { ...validInput, observedSourceUrl: "https://www.xiaohongshu.com/explore/another" }), /OBSERVED_SOURCE_PATH_MISMATCH/);
});

test("all matching fields on complete machine coverage produce an integrity-verifiable pass", () => {
  const receipt = createBrowserHumanComparison(validation, validInput, { createdAt: "2026-09-25T01:00:00.000Z" });
  assert.equal(receipt.humanComparisonStatus, "PASS");
  assert.deepEqual(receipt.summary, { totalFields: 2, matches: 2, mismatches: 0, notObservable: 0 });
  assert.equal(verifyBrowserHumanComparison(receipt), true);
});

test("one mismatch fails the comparison", () => {
  const receipt = createBrowserHumanComparison(validation, { ...validInput, verdicts: [{ key: "detail.title", verdict: "MISMATCH", note: "标题不一致" }, validInput.verdicts[1]] });
  assert.equal(receipt.humanComparisonStatus, "FAIL");
});

test("not observable or partial coverage stays incomplete and tampering is detectable", () => {
  const partial = { ...validation, machineCoverageStatus: "PARTIAL", fields: [{ ...fields[0], present: false }, fields[1]] };
  const receipt = createBrowserHumanComparison(partial, { ...validInput, verdicts: [{ key: "detail.title", verdict: "NOT_OBSERVABLE" }, validInput.verdicts[1]] });
  assert.equal(receipt.humanComparisonStatus, "INCOMPLETE");
  assert.equal(verifyBrowserHumanComparison({ ...receipt, reviewer: "tampered" }), false);
  assert.throws(() => createBrowserHumanComparison(partial, validInput), /MISSING_MACHINE_FIELD_CANNOT_MATCH/);
});
