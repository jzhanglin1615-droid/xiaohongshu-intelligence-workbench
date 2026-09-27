function canonicalUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function normalizedPath(value) {
  return value.replace(/\/+$/, "") || "/";
}

function normalizedKeyword(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

/**
 * Compare the leased target with the final visible page semantically.
 * Xiaohongshu may add query parameters or consume the original search query,
 * so raw URL equality is too strict. Identity-bearing host/path/keyword data
 * must still match; this never accepts a different note or keyword.
 */
export function matchesBrowserTaskTarget(task, currentUrl, snapshot = {}) {
  const current = canonicalUrl(currentUrl);
  const target = canonicalUrl(task?.targetUrl);
  if (!current || !target) return false;
  if (current.href === target.href) return true;

  const sameOrigin = current.origin.toLocaleLowerCase() === target.origin.toLocaleLowerCase();
  const samePath = normalizedPath(current.pathname) === normalizedPath(target.pathname);
  if (!sameOrigin) return false;

  if (task?.expectedPageType === "NOTE_DETAIL" && snapshot?.pageType === "NOTE_DETAIL") {
    const expectedNoteId = String(task?.context?.noteId || target.pathname.match(/\/explore\/([^/?#]+)/)?.[1] || "");
    const routeNoteId = String(current.pathname.match(/\/explore\/([^/?#]+)/)?.[1] || "");
    const mayBeSearchModal = task?.context?.navigationMode === "CLICK_SEARCH_CARD";
    if (!routeNoteId && !mayBeSearchModal) return false;
    const observedNoteId = String(snapshot?.noteId || routeNoteId || "");
    return Boolean(expectedNoteId && observedNoteId === expectedNoteId);
  }

  if (!samePath) return false;

  if (task?.expectedPageType === "SEARCH" && snapshot?.pageType === "SEARCH") {
    const expectedKeyword = normalizedKeyword(task?.context?.keyword || target.searchParams.get("keyword"));
    const observedKeyword = normalizedKeyword(snapshot?.keyword || current.searchParams.get("keyword"));
    if (observedKeyword) return Boolean(expectedKeyword) && observedKeyword === expectedKeyword;
    return Boolean(expectedKeyword && Array.isArray(snapshot?.cards) && snapshot.cards.length > 0);
  }

  return false;
}
