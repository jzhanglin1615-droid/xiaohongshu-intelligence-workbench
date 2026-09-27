(function registerCommentTraversalController(root) {
  function decide(snapshot, actionsTaken = 0, maxActions = 24) {
    if (snapshot?.pageType !== "NOTE_DETAIL" || snapshot?.status !== "VISIBLE") return { action: "NONE", reason: "NOT_VISIBLE_NOTE_DETAIL" };
    const state = snapshot.commentTraversal;
    if (!state) return { action: "HALT", reason: "COMMENT_TRAVERSAL_EVIDENCE_MISSING" };
    if (state.complete) return { action: "COMPLETE", reason: "COMMENT_TRAVERSAL_COMPLETE" };
    if (actionsTaken >= maxActions) return { action: "HALT", reason: "COMMENT_TRAVERSAL_BUDGET_EXHAUSTED" };
    if (state.sectionObserved === false) return { action: "ADVANCE", reason: "DISCOVER_COMMENT_SECTION" };
    if (state.expandableReplyCount > 0) return { action: "ADVANCE", reason: "EXPAND_REPLIES" };
    if (state.hasMoreRootComments) return { action: "ADVANCE", reason: "LOAD_MORE_COMMENTS" };
    if (!state.bottomReached) return { action: "ADVANCE", reason: "SCROLL_COMMENTS" };
    return { action: "HALT", reason: "COMMENT_TRAVERSAL_INCONSISTENT" };
  }

  root.XhsCommentTraversalController = { decide };
})(globalThis);
