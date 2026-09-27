import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateNoteCompleteness,
  type NoteCompletenessObservation,
} from "../src/completeness-ledger.ts";

function observation(overrides: Partial<NoteCompletenessObservation> = {}): NoteCompletenessObservation {
  return {
    noteId: "note-a",
    observedAt: "2026-09-24T04:00:00.000Z",
    detail: {
      access: "VISIBLE",
      requiredFields: ["title", "body", "author"],
      presentFields: ["title"],
      evidenceEnvelopeIds: ["raw-detail-1"],
    },
    comments: {
      access: "VISIBLE",
      platformDeclaredTotal: 3,
      capturedTopLevelIds: ["comment-1"],
      replyThreads: [{
        parentCommentId: "comment-1",
        declaredReplyCount: 1,
        capturedReplyIds: [],
        expansionExhausted: false,
      }],
      topLevelPaginationExhausted: false,
      nextCursor: "cursor-2",
      evidenceEnvelopeIds: ["raw-comments-1"],
    },
    ...overrides,
  };
}

test("an open detail/comment observation remains PARTIAL with explicit gaps", () => {
  const ledger = evaluateNoteCompleteness(observation());
  assert.equal(ledger.detail.status, "PARTIAL");
  assert.deepEqual(ledger.detail.missingFields, ["author", "body"]);
  assert.equal(ledger.comments.status, "PARTIAL");
  assert.equal(ledger.comments.countGap, 2);
  assert.equal(ledger.comments.unresolvedReplyThreads, 1);
  assert.equal(ledger.overallStatus, "PARTIAL");
});

test("multiple observations merge unique evidence and close only after total and replies reconcile", () => {
  const first = evaluateNoteCompleteness(observation());
  const second = evaluateNoteCompleteness(observation({
    observedAt: "2026-09-24T04:10:00.000Z",
    detail: {
      access: "VISIBLE",
      requiredFields: ["title", "body", "author"],
      presentFields: ["body", "author"],
      evidenceEnvelopeIds: ["raw-detail-2"],
    },
    comments: {
      access: "VISIBLE",
      platformDeclaredTotal: 3,
      capturedTopLevelIds: ["comment-2"],
      replyThreads: [{
        parentCommentId: "comment-1",
        declaredReplyCount: 1,
        capturedReplyIds: ["reply-1"],
        expansionExhausted: true,
      }],
      topLevelPaginationExhausted: true,
      nextCursor: null,
      evidenceEnvelopeIds: ["raw-comments-2"],
    },
  }), first);
  assert.equal(second.detail.status, "COMPLETE");
  assert.equal(second.comments.status, "COMPLETE");
  assert.equal(second.comments.capturedUniqueCount, 3);
  assert.equal(second.comments.countGap, 0);
  assert.equal(second.comments.unresolvedReplyThreads, 0);
  assert.equal(second.overallStatus, "COMPLETE");
  assert.equal(second.observationCount, 2);
});

test("exhausted comments with no declared total remain PROVISIONAL", () => {
  const ledger = evaluateNoteCompleteness(observation({
    detail: {
      access: "VISIBLE",
      requiredFields: ["title"],
      presentFields: ["title"],
      evidenceEnvelopeIds: ["raw-detail"],
    },
    comments: {
      access: "VISIBLE",
      platformDeclaredTotal: null,
      capturedTopLevelIds: ["comment-1"],
      replyThreads: [],
      topLevelPaginationExhausted: true,
      nextCursor: null,
      evidenceEnvelopeIds: ["raw-comments"],
    },
  }));
  assert.equal(ledger.comments.status, "PROVISIONAL");
  assert.equal(ledger.overallStatus, "PROVISIONAL");
});

test("drift and human-required states are blocked rather than retried as ordinary gaps", () => {
  const ledger = evaluateNoteCompleteness(observation({
    detail: { ...observation().detail, access: "DRIFTED" },
    comments: { ...observation().comments, access: "HUMAN_REQUIRED" },
  }));
  assert.equal(ledger.detail.status, "DRIFTED");
  assert.equal(ledger.comments.status, "HUMAN_REQUIRED");
  assert.equal(ledger.overallStatus, "BLOCKED");
});
