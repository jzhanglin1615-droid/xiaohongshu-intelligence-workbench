import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./comment-traversal-controller.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const decide = context.XhsCommentTraversalController.decide;
const note = { pageType: "NOTE_DETAIL", status: "VISIBLE", commentTraversal: { complete: false, expandableReplyCount: 0, hasMoreRootComments: false, bottomReached: false } };

test("completed comment traversal can enter the evidence stability gate", () => {
  assert.equal(decide({ ...note, commentTraversal: { ...note.commentTraversal, complete: true } }).action, "COMPLETE");
});

test("reply expansion has priority over root pagination and scrolling", () => {
  const result = decide({ ...note, commentTraversal: { ...note.commentTraversal, expandableReplyCount: 2, hasMoreRootComments: true } });
  assert.deepEqual({ action: result.action, reason: result.reason }, { action: "ADVANCE", reason: "EXPAND_REPLIES" });
});

test("root pagination precedes scrolling", () => {
  assert.equal(decide({ ...note, commentTraversal: { ...note.commentTraversal, hasMoreRootComments: true } }).reason, "LOAD_MORE_COMMENTS");
});

test("unfinished traversal scrolls until the bottom is observed", () => {
  assert.equal(decide(note).reason, "SCROLL_COMMENTS");
});

test("missing traversal evidence and exhausted budgets halt", () => {
  assert.equal(decide({ pageType: "NOTE_DETAIL", status: "VISIBLE" }).reason, "COMMENT_TRAVERSAL_EVIDENCE_MISSING");
  assert.equal(decide(note, 24, 24).reason, "COMMENT_TRAVERSAL_BUDGET_EXHAUSTED");
});

test("an unobserved comment section is discovered before it can be called complete", () => {
  const result = decide({ ...note, commentTraversal: { ...note.commentTraversal, sectionObserved: false } });
  assert.deepEqual({ action: result.action, reason: result.reason }, { action: "ADVANCE", reason: "DISCOVER_COMMENT_SECTION" });
});
