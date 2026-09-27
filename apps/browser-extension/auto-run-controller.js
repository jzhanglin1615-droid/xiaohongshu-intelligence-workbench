(function registerAutoRunController(root) {
  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  function stabilityKey(snapshot) {
    const cardIds = (snapshot?.cards || []).map((item) => item.noteId || item.sourceUrl || item.title || "");
    const comments = (snapshot?.visibleComments || []).map((item) => `${item.author || ""}:${item.text || item.rawText || ""}`);
    return JSON.stringify({
      pageType: snapshot?.pageType || "UNKNOWN",
      status: snapshot?.status || "UNKNOWN_STRUCTURE",
      noteId: snapshot?.noteId || "",
      cardIds,
      comments,
      visibleTextLength: String(snapshot?.visibleText || "").length
    });
  }

  function normalizedKeyword(value) {
    return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  }

  function expectedNoteId(task) {
    const fromContext = String(task?.context?.noteId || "").trim();
    if (fromContext) return fromContext;
    try { return new URL(task?.targetUrl).pathname.match(/\/explore\/([^?/#]+)/)?.[1] || ""; }
    catch { return ""; }
  }

  function matchesTaskTarget(task, currentUrl, snapshot) {
    if (canonicalUrl(currentUrl) === canonicalUrl(task?.targetUrl)) return true;
    if (task?.expectedPageType === "NOTE_DETAIL" && snapshot?.pageType === "NOTE_DETAIL") {
      try {
        const current = new URL(currentUrl);
        const target = new URL(task.targetUrl);
        const routeNoteId = String(current.pathname.match(/\/explore\/([^?/#]+)/)?.[1] || "");
        const mayBeSearchModal = task?.context?.navigationMode === "CLICK_SEARCH_CARD";
        if (!routeNoteId && !mayBeSearchModal) return false;
        const observedNoteId = String(snapshot?.noteId || routeNoteId || "");
        return current.origin.toLocaleLowerCase() === target.origin.toLocaleLowerCase()
          && Boolean(expectedNoteId(task))
          && observedNoteId === expectedNoteId(task);
      } catch { return false; }
    }
    if (task?.expectedPageType !== "SEARCH" || snapshot?.pageType !== "SEARCH") return false;
    try {
      const current = new URL(currentUrl);
      const target = new URL(task.targetUrl);
      const sameHost = current.hostname.toLocaleLowerCase() === target.hostname.toLocaleLowerCase();
      const path = (value) => value.replace(/\/+$/, "") || "/";
      if (!sameHost || path(current.pathname) !== path(target.pathname)) return false;
      const expectedKeyword = normalizedKeyword(task.context?.keyword || target.searchParams.get("keyword"));
      const observedKeyword = normalizedKeyword(snapshot?.keyword || current.searchParams.get("keyword"));
      if (observedKeyword) return observedKeyword === expectedKeyword;
      // Xiaohongshu may consume the query and replace the address with /search_result/.
      // A populated result grid on that redirected route is the visible evidence that
      // the navigation completed; accepting it prevents an infinite redirect loop.
      return Boolean(expectedKeyword && Array.isArray(snapshot?.cards) && snapshot.cards.length > 0);
    } catch {
      return false;
    }
  }

  function matchesParentSearch(task, currentUrl, snapshot) {
    const parentSearchUrl = task?.context?.parentSearchUrl;
    if (!parentSearchUrl || snapshot?.pageType !== "SEARCH") return false;
    return matchesTaskTarget({
      targetUrl: parentSearchUrl,
      expectedPageType: "SEARCH",
      context: { keyword: task?.context?.keyword || "" }
    }, currentUrl, snapshot);
  }

  function shouldAutoStart(state) {
    if (state?.enabled === true) return false;
    if (state?.userPaused === true) return false;
    return true;
  }

  class StabilityTracker {
    constructor({ requiredMatches = 3, maxWaitMs = 12_000 } = {}) {
      this.requiredMatches = requiredMatches;
      this.maxWaitMs = maxWaitMs;
      this.reset();
    }

    reset(startedAt = 0) {
      this.startedAt = startedAt;
      this.lastKey = null;
      this.consecutive = 0;
    }

    observe(snapshot, now) {
      if (!this.startedAt) this.startedAt = now;
      const key = stabilityKey(snapshot);
      this.consecutive = key === this.lastKey ? this.consecutive + 1 : 1;
      this.lastKey = key;
      return {
        stable: this.consecutive >= this.requiredMatches,
        timedOut: now - this.startedAt >= this.maxWaitMs,
        consecutive: this.consecutive,
        key
      };
    }
  }

  function decide({ enabled, task, currentUrl, snapshot, stable = false, timedOut = false }) {
    if (!enabled) return { action: "IDLE", reason: "AUTO_RUN_DISABLED" };
    if (!task) return { action: "LEASE", reason: "NO_ACTIVE_TASK" };
    if (snapshot?.status === "HUMAN_REQUIRED") return { action: "SUBMIT_AND_RETRY", reason: snapshot.status };
    if (task?.expectedPageType === "NOTE_DETAIL" && task?.context?.navigationMode === "CLICK_SEARCH_CARD" && !matchesTaskTarget(task, currentUrl, snapshot)) {
      const noteId = expectedNoteId(task);
      const parentSearchUrl = task.context.parentSearchUrl;
      // A completed detail stays open when the queue leases the next note.
      // Return only from an identified visible note, never from a challenge/404.
      if (snapshot?.status === "VISIBLE" && snapshot?.pageType === "NOTE_DETAIL" && snapshot.noteId && snapshot.noteId !== noteId && parentSearchUrl) {
        return { action: "NAVIGATE", reason: "RETURN_TO_PARENT_SEARCH", targetUrl: parentSearchUrl };
      }
      if (matchesParentSearch(task, currentUrl, snapshot)) {
        if ((snapshot?.cards || []).some((card) => card?.noteId === noteId)) return { action: "OPEN_SEARCH_CARD", reason: "TARGET_CARD_VISIBLE", noteId };
        if (stable || timedOut) return { action: "SKIP_AND_CONTINUE", reason: "NOTE_NOT_VISIBLE_IN_PARENT_SEARCH", noteId };
        return { action: "WAIT", reason: "WAITING_FOR_PARENT_SEARCH" };
      }
      // A click-mode detail task is valid only while the evidenced parent card
      // or its opened detail is visible. Navigating back from a 404/unknown page
      // caused a search -> click -> 404 -> search loop. Preserve the failing page
      // as diagnostic evidence. The content script records a task-bound failure
      // for this legacy action name instead of retrying the same lease forever.
      return { action: "SUBMIT_AND_RETRY", reason: "CARD_OPEN_FAILED", targetUrl: parentSearchUrl };
    }
    if (!matchesTaskTarget(task, currentUrl, snapshot)) return { action: "NAVIGATE", reason: "TARGET_URL_MISMATCH", targetUrl: task.targetUrl };
    if (snapshot?.status === "UNKNOWN_STRUCTURE") return { action: "SUBMIT_AND_RETRY", reason: snapshot.status };
    if (snapshot?.pageType !== task.expectedPageType) return { action: "SUBMIT_AND_RETRY", reason: "PAGE_TYPE_MISMATCH" };
    if (timedOut) return { action: "FAIL_AND_RETRY", reason: "PAGE_NOT_STABLE" };
    if (!stable) return { action: "WAIT", reason: "WAITING_FOR_STABLE_PAGE" };
    return { action: "SUBMIT", reason: "PAGE_STABLE" };
  }

  root.XhsAutoRunController = { canonicalUrl, normalizedKeyword, expectedNoteId, matchesTaskTarget, matchesParentSearch, shouldAutoStart, stabilityKey, StabilityTracker, decide };
})(globalThis);
