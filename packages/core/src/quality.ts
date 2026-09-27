import {
  CONTRACT_VERSION,
  type CanonicalNote,
  type QualityDecision,
  type QualityIssue,
} from "../../contracts/src/index.ts";

export const QUALITY_RULES_VERSION = "1.0.0";

export function evaluateNote(note: CanonicalNote, evaluatedAt: string): QualityDecision {
  const issues: QualityIssue[] = [];

  if (note.body === null || note.body.trim().length === 0) {
    issues.push({
      code: "MISSING_BODY",
      severity: "BLOCK",
      field: "body",
      message: "The detail body is missing; card data must not masquerade as a complete detail.",
    });
  }

  if (note.expectedAssetCount !== null && note.expectedAssetCount !== note.assets.length) {
    issues.push({
      code: "ASSET_COUNT_MISMATCH",
      severity: "WARN",
      field: "assets",
      message: `Expected ${note.expectedAssetCount} assets but observed ${note.assets.length}.`,
    });
  }

  if (note.provenance.envelopeIds.length < 2) {
    issues.push({
      code: "PROVENANCE_INCOMPLETE",
      severity: "BLOCK",
      field: "provenance",
      message: "Both search-card and detail evidence are required.",
    });
  }

  const decision = issues.some((issue) => issue.severity === "BLOCK")
    ? "BLOCK"
    : issues.length > 0
      ? "WARN"
      : "PASS";

  return {
    schemaVersion: CONTRACT_VERSION,
    entityType: "NOTE",
    entityId: note.noteId,
    decision,
    issues,
    evaluatedAt,
    rulesVersion: QUALITY_RULES_VERSION,
  };
}
