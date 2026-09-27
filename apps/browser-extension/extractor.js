(function registerExtractor(root) {
  const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim() || "";
  const firstText = (selectors, rootNode = document) => {
    for (const selector of selectors) {
      const value = text(rootNode?.querySelector?.(selector));
      if (value) return value;
    }
    return "";
  };
  const parseVisibleMetric = (value, zeroLabels = []) => {
    const raw = String(value || "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    if (zeroLabels.includes(raw)) return 0;
    const match = raw.replaceAll(",", "").match(/(\d+(?:\.\d+)?)\s*([万千wWkK]?)/);
    if (!match) return null;
    const factor = /万|w/i.test(match[2]) ? 10000 : /千|k/i.test(match[2]) ? 1000 : 1;
    return Math.round(Number(match[1]) * factor);
  };
  const metric = (selectors) => parseVisibleMetric(firstText(selectors));
  const attr = (node, names) => {
    for (const name of names) {
      const value = node?.getAttribute?.(name);
      if (value) return value;
    }
    return "";
  };
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const noteLinkSelector = "a[href*='/explore/']";
  const searchCardSelector = "section.note-item, .note-item, [class*='note-item']";
  const maximumSearchCandidates = 10000;

  function pageType(url, hasVisibleDetail = false) {
    return /\/explore\//.test(url) || hasVisibleDetail ? "NOTE_DETAIL" : /\/search_result/.test(url) ? "SEARCH" : "UNKNOWN";
  }

  function isVisibleElement(node) {
    if (!node) return false;
    const style = globalThis.getComputedStyle?.(node);
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = node.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function visibleDetailRoot(rootNode = document) {
    const selectors = [
      "#noteContainer",
      ".note-detail-mask",
      "[class*='note-detail-mask']",
      "[class*='note-detail'][role='dialog']",
      "[role='dialog'] [class*='interaction-container']",
      "[class*='interaction-container']"
    ];
    for (const selector of selectors) {
      for (const node of [...(rootNode?.querySelectorAll?.(selector) || [])]) {
        if (!isVisibleElement(node)) continue;
        const hasDetailSignal = Boolean(node.querySelector?.("#detail-title, #detail-desc, [class*='note-content'], [class*='comments-container'], [class*='engage-bar']"));
        if (hasDetailSignal || text(node).length > 80) return node;
      }
    }
    return null;
  }

  function detailScopeForCapture(_url, rootNode = document) {
    // Xiaohongshu rewrites the address bar to /explore/<id> while keeping the
    // search grid mounted behind a detail overlay. The visible overlay remains
    // the authoritative scope regardless of the current URL shape.
    return visibleDetailRoot(rootNode) || rootNode;
  }

  function cleanDetailDocumentTitle(value) {
    const cleaned = String(value || "")
      .replace(/\s*[-_|]\s*小红书(?:\s*[-_|].*)?$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || /^(小红书|你访问的页面不见了|当前笔记暂时无法浏览)/.test(cleaned)) return "";
    return cleaned;
  }

  function extractDetailTitle(rootNode, documentTitle = "", bodyText = "") {
    const precise = firstText([
      "#detail-title",
      "[class*='note-content'] [class~='title']",
      "[class*='note-content'] [class*='title']",
      "[class*='detail-content'] [class~='title']",
      "[class*='detail-content'] [class*='title']"
    ], rootNode);
    if (precise) return precise;
    const fromDocument = cleanDetailDocumentTitle(documentTitle);
    if (fromDocument) return fromDocument;
    return String(bodyText || "").split(/\n|#/)[0].replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function parseDeclaredCommentTotal(value) {
    const raw = String(value || "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    if (/暂无评论|还没有评论|暂时没有评论|成为第一个评论的人/.test(raw)) return 0;
    const match = raw.match(/(?:共\s*)?(\d[\d,]*)\s*条评论/);
    return match ? Number(match[1].replaceAll(",", "")) : null;
  }

  function declaredCommentTotal(rootNode) {
    const selectors = [
      "[class*='comments-container'] [class*='total']",
      "[class*='comments-header']",
      "[class*='comment-header']",
      "[class*='comment-title']",
      "[class*='comments-title']",
      "[class*='comment-count']"
    ];
    for (const selector of selectors) {
      const value = parseDeclaredCommentTotal(text(rootNode?.querySelector?.(selector)));
      if (value !== null) return value;
    }
    return parseDeclaredCommentTotal(text(rootNode).slice(0, 12000));
  }

  function searchKeyword(url, root = document) {
    const fromUrl = new URL(url).searchParams.get("keyword")?.normalize("NFKC").trim();
    if (fromUrl) return fromUrl;
    const selectors = [
      "input.search-input",
      ".search-input input",
      "[class*='search-input'] input",
      "input[type='search']",
      "input[placeholder*='搜索']"
    ];
    for (const selector of selectors) {
      const value = root?.querySelector?.(selector)?.value?.normalize?.("NFKC").trim();
      if (value) return value;
    }
    return "";
  }

  function humanRequired() {
    const body = text(document.body).slice(0, 4000);
    return /登录后|请先登录|安全验证|验证码|访问过于频繁/.test(body);
  }

  const genericCommentText = new Set([
    "好", "好的", "好棒", "真棒", "不错", "太好了", "厉害", "支持", "赞", "顶", "蹲", "路过", "已阅",
    "哈哈", "哈哈哈", "哈哈哈哈", "学习了", "学到了", "收藏了", "谢谢", "谢谢分享", "爱了", "绝了", "666"
  ]);

  function compactCommentText(value) {
    return String(value || "").normalize("NFKC").trim().replace(/\s+/g, "").replace(/[，。！？!?、,.~～…：:；;“”'"（）()【】\[\]]+/g, "");
  }

  function commentValueReasons(value) {
    const content = String(value || "");
    const reasons = [];
    if (/[?？]|怎么|如何|为什么|哪里|哪儿|哪个|有没有|能不能|是否|可以吗|请问|求问|想知道/.test(content)) reasons.push("QUESTION_OR_INFORMATION_NEED");
    if (/需要|想要|希望|求|推荐|链接|教程|步骤|清单|模板|价格|多少钱|怎么买|购买|报名|合作|联系/.test(content)) reasons.push("EXPLICIT_DEMAND_OR_ACTION_INTENT");
    if (/不会|不懂|困难|痛点|问题|失败|卡住|解决|怎么办|适合|建议|亲测|实测|用了|试过|经验/.test(content)) reasons.push("PAIN_POINT_OR_EXPERIENCE");
    if (/但是|不过|担心|缺点|避坑|踩坑|风险|太贵|没用|不行|不同意|不建议/.test(content)) reasons.push("OBJECTION_OR_RISK_SIGNAL");
    return reasons;
  }

  function observedComments(rootNode = document) {
    const nodes = rootNode?.querySelectorAll?.(".comment-item, [class*='comment-item'], [data-v-aed4b9d0].comment") || [];
    return [...nodes].slice(0, 1500).map((node, index) => ({
      ordinal: index + 1,
      platformCommentId: attr(node, ["data-comment-id", "data-commentid", "data-id", "id"]),
      parentCommentId: attr(node, ["data-parent-comment-id", "data-parent-id", "data-root-comment-id", "data-root-id"]),
      author: firstDescendantText(node, [".author", ".name", "[class*='author']", "[class*='name']"]),
      text: firstDescendantText(node, [".content", ".note-text", "[class*='content']"]),
      likes: metricWithin(node, ["[class*='like'] [class*='count']", "[class*='like-count']", "[class*='likes']"], ["赞"]),
      isReply: Boolean(node.matches?.("[class*='comment-item-sub'], [class*='reply']") || node.closest?.("[class*='reply-container'], [class*='sub-comment']")),
      replyTo: firstDescendantText(node, ["[class*='reply-to']", "[class*='target-name']"]),
      rawText: text(node).slice(0, 1000)
    })).filter((item) => item.text || item.rawText);
  }

  function mergeObservedComments(previous = [], current = [], limit = 500) {
    const merged = new Map();
    for (const item of [...previous, ...current]) {
      const content = String(item?.text || item?.rawText || "").trim();
      const key = String(item?.platformCommentId || "").trim()
        || `${String(item?.author || "").trim()}|${compactCommentText(content)}|${String(item?.parentCommentId || item?.replyTo || "").trim()}`;
      if (!content || !key) continue;
      merged.set(key, { ...(merged.get(key) || {}), ...item, ordinal: merged.get(key)?.ordinal || item.ordinal || merged.size + 1 });
      if (merged.size >= limit) break;
    }
    return [...merged.values()];
  }

  function selectUsefulComments(comments = []) {
    const source = mergeObservedComments([], comments, 500);
    const positiveLikes = source.map((item) => Math.max(0, Number(item.likes) || 0)).filter(Boolean).sort((a, b) => b - a);
    const agreementFloor = positiveLikes.length ? Math.max(2, positiveLikes[Math.ceil((positiveLikes.length - 1) * 0.25)]) : Number.POSITIVE_INFINITY;
    const selected = [];
    const seenText = new Set();
    for (const item of source) {
      const content = String(item.text || item.rawText || "").trim();
      const compact = compactCommentText(content);
      const reasons = commentValueReasons(content);
      const likes = Math.max(0, Number(item.likes) || 0);
      if (!compact || genericCommentText.has(compact) || /^[\p{P}\p{S}\p{N}]+$/u.test(compact) || (compact.length <= 2 && !reasons.length) || seenText.has(compact)) continue;
      if (likes >= agreementFloor) reasons.unshift("HIGH_AGREEMENT");
      if (!reasons.length) continue;
      seenText.add(compact);
      selected.push({ ...item, likes, selectionReasons: [...new Set(reasons)], valueScore: Math.min(100, reasons.length * 24 + Math.round(Math.log10(likes + 1) * 18)) });
    }
    return selected.sort((a, b) => (b.valueScore || 0) - (a.valueScore || 0) || (b.likes || 0) - (a.likes || 0) || (a.ordinal || 0) - (b.ordinal || 0));
  }

  function visibleComments(rootNode = document) {
    return selectUsefulComments(observedComments(rootNode));
  }

  function firstDescendantText(parent, selectors) {
    for (const selector of selectors) {
      const value = text(parent.querySelector(selector));
      if (value) return value;
    }
    return "";
  }

  function noteAnchor(node) {
    const ownHref = node?.href || attr(node, ["href"]);
    if (/\/explore\//.test(String(ownHref || ""))) return node;
    return node?.querySelector?.(noteLinkSelector) || null;
  }

  function searchCardContainer(anchor) {
    if (!anchor) return null;
    const explicit = anchor.closest?.(searchCardSelector);
    if (explicit) return explicit;
    let current = anchor.parentElement;
    let oneLinkAncestor = null;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      const links = [...(current.querySelectorAll?.(noteLinkSelector) || [])];
      if (links.length > 1) break;
      if (links.length === 1) {
        oneLinkAncestor = current;
        if (text(current)) return current;
      }
    }
    return oneLinkAncestor || anchor;
  }

  function searchCardMediaType(node) {
    const directMarker = node?.querySelector?.("video, [data-type='video'], [data-note-type='video'], [aria-label*='视频'], [title*='视频'], [class*='play-icon'], [class*='video-icon']");
    if (directMarker) return "VIDEO";
    const symbolUses = [...(node?.querySelectorAll?.("use") || [])];
    if (symbolUses.some((item) => /(?:video|play)/i.test(attr(item, ["href", "xlink:href", "id", "class"])))) return "VIDEO";
    const durationMarker = node?.querySelector?.("[class*='duration'], [class*='video-time'], [class*='play-time']");
    return /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(text(durationMarker)) ? "VIDEO" : "UNKNOWN";
  }

  function buildSearchCard(node, ordinal) {
    const anchor = noteAnchor(node);
    const rawHref = anchor?.href || attr(anchor, ["href"]);
    let sourceUrl;
    try {
      sourceUrl = new URL(rawHref, "https://www.xiaohongshu.com");
    } catch {
      return null;
    }
    const noteId = sourceUrl.pathname.match(/\/explore\/([^?/#]+)/)?.[1] || "";
    if (sourceUrl.protocol !== "https:" || !/(^|\.)xiaohongshu\.com$/i.test(sourceUrl.hostname) || !noteId) return null;
    return {
      ordinal,
      noteId,
      title: firstDescendantText(node, [".title", "[class*='note-title']", "[class*='title']"]),
      authorName: firstDescendantText(node, [".author .name", "[class*='author'] [class*='name']", ".author-name", "[class*='author-name']", ".name", ".author", "[class*='author']"]),
      sourceUrl: sourceUrl.href,
      coverUrl: (() => {
        const image = node.querySelector?.("img");
        const raw = image?.currentSrc || image?.src || image?.getAttribute?.("src") || "";
        try {
          const url = new URL(raw, "https://www.xiaohongshu.com");
          return ["http:", "https:"].includes(url.protocol) ? url.href : null;
        } catch { return null; }
      })(),
      likes: metricWithin(node, [".like-wrapper .count", "[class*='like'] [class*='count']", ".like-wrapper", "[class*='like']"], ["赞"]),
      collects: metricWithin(node, [".collect-wrapper .count", "[class*='collect'] [class*='count']", ".collect-wrapper"], ["收藏"]),
      shares: metricWithin(node, [".share-wrapper .count", "[class*='share'] [class*='count']", ".share-wrapper"], ["分享", "转发"]),
      mediaType: searchCardMediaType(node),
      rawText: text(node).slice(0, 1000)
    };
  }

  function searchCards(rootNode = document) {
    const primaryNodes = [...(rootNode?.querySelectorAll?.(searchCardSelector) || [])];
    const anchorNodes = [...(rootNode?.querySelectorAll?.(noteLinkSelector) || [])]
      .map((anchor) => searchCardContainer(anchor));
    // The live site changes the result-card class during hydration. Keep the
    // precise note-item path first, then recover from real /explore/ links.
    // A real Xiaohongshu note URL remains mandatory, so recommendation blocks
    // and unrelated containers still fail closed.
    const nodes = [...new Set([...primaryNodes, ...anchorNodes].filter(Boolean))];
    const cards = [];
    const seenNoteIds = new Set();
    for (const node of nodes.slice(0, maximumSearchCandidates)) {
      const card = buildSearchCard(node, cards.length + 1);
      if (!card || seenNoteIds.has(card.noteId)) continue;
      seenNoteIds.add(card.noteId);
      cards.push(card);
    }
    return cards;
  }

  function mergeSearchCards(existing = [], incoming = [], limit = 1500) {
    const merged = new Map();
    for (const card of [...existing, ...incoming]) {
      if (!card?.noteId) continue;
      const previous = merged.get(card.noteId);
      merged.set(card.noteId, previous
        ? { ...previous, ...card, ordinal: previous.ordinal ?? card.ordinal }
        : { ...card });
    }
    return [...merged.values()]
      .sort((a, b) => (Number(a.ordinal) || Number.MAX_SAFE_INTEGER) - (Number(b.ordinal) || Number.MAX_SAFE_INTEGER))
      .slice(0, Math.min(maximumSearchCandidates, Math.max(1, Number(limit) || 200)))
      .map((card, index) => ({ ...card, ordinal: index + 1 }));
  }

  function searchScrollableRoot(rootNode = document) {
    const selectors = [
      "[class*='feeds-container']", "[class*='search-result']", "[class*='note-list']",
      "main", "[role='main']"
    ];
    const candidates = [
      ...(rootNode?.scrollingElement ? [rootNode.scrollingElement] : []),
      ...(rootNode?.documentElement ? [rootNode.documentElement] : []),
      ...selectors.flatMap((selector) => [...(rootNode?.querySelectorAll?.(selector) || [])]),
    ].filter(Boolean);
    return [...new Set(candidates)]
      .filter((node) => Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) + 80)
      .sort((a, b) => (Number(b.scrollHeight || 0) - Number(b.clientHeight || 0)) - (Number(a.scrollHeight || 0) - Number(a.clientHeight || 0)))[0] || null;
  }

  function advanceSearchResults(rootNode = document) {
    const scrollRoot = searchScrollableRoot(rootNode);
    if (!scrollRoot) return { advanced: false, action: "SEARCH_SCROLL_ROOT_NOT_FOUND" };
    const before = Number(scrollRoot.scrollTop || 0);
    const clientHeight = Number(scrollRoot.clientHeight || globalThis.innerHeight || 640);
    const maximum = Math.max(0, Number(scrollRoot.scrollHeight || 0) - clientHeight);
    const target = Math.min(maximum, before + Math.max(900, Math.round(clientHeight * 1.8)));
    if (target <= before + 2) return { advanced: false, action: "SEARCH_BOTTOM_REACHED", from: before, to: before, maximum };
    if (typeof scrollRoot.scrollTo === "function") scrollRoot.scrollTo({ top: target, behavior: "auto" });
    else scrollRoot.scrollTop = target;
    // Keep this synchronous for both document scrollers and nested feeds; the
    // caller waits for Xiaohongshu's lazy-loading before capturing again.
    if (Number(scrollRoot.scrollTop || 0) < target) scrollRoot.scrollTop = target;
    return { advanced: true, action: "SCROLL_SEARCH_RESULTS", from: before, to: target, maximum };
  }

  function openSearchCard(noteId, rootNode = document) {
    const expected = String(noteId || "").trim();
    if (!expected) return { opened: false, reason: "NOTE_ID_REQUIRED" };
    const anchors = [...(rootNode?.querySelectorAll?.(noteLinkSelector) || [])];
    const matches = anchors.filter((candidate) => {
      try {
        const url = new URL(candidate.href || candidate.getAttribute?.("href") || "", "https://www.xiaohongshu.com");
        return url.pathname.match(/\/explore\/([^?/#]+)/)?.[1] === expected;
      } catch { return false; }
    });
    const visibleContainer = (candidate) => {
      const container = searchCardContainer(candidate);
      return isVisibleElement(container) ? container : null;
    };
    // Preserve Xiaohongshu's own interaction path. Rewriting the link target to
    // `_self` converted a site-managed card interaction into a naked /explore/
    // navigation, which can land on the platform's 404 route. When the real
    // anchor is a zero-sized overlay, click a visible cover/image surface owned
    // by the same card so the event reaches the site's card handlers.
    const anchor = matches.find((candidate) => isVisibleElement(candidate))
      || matches.find((candidate) => visibleContainer(candidate));
    if (!anchor) return { opened: false, reason: "TARGET_CARD_NOT_FOUND", noteId: expected };
    const container = visibleContainer(anchor);
    const anchorVisible = isVisibleElement(anchor);
    const surfaceSelectors = [
      "a.cover",
      "[class~='cover']",
      "[class*='cover'] img",
      "picture img",
      "img"
    ];
    let clickTarget = anchorVisible ? anchor : null;
    if (!clickTarget && container) {
      for (const selector of surfaceSelectors) {
        const candidates = [...(container.querySelectorAll?.(selector) || [])];
        if (candidates.length === 0) {
          const single = container.querySelector?.(selector);
          if (single) candidates.push(single);
        }
        clickTarget = candidates.find((candidate) => candidate !== anchor && isVisibleElement(candidate)) || null;
        if (clickTarget) break;
      }
      if (!clickTarget && typeof container.click === "function") clickTarget = container;
    }
    if (!clickTarget?.click) return { opened: false, reason: "VISIBLE_CARD_SURFACE_NOT_FOUND", noteId: expected };
    const scrollTarget = anchorVisible ? anchor : container;
    scrollTarget?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "auto" });
    clickTarget.click();
    return { opened: true, noteId: expected, strategy: anchorVisible ? "VISIBLE_ANCHOR" : "VISIBLE_CARD_SURFACE" };
  }

  function searchSuggestions(currentKeyword) {
    const selectors = ["[class*='search-suggest'] li", "[class*='suggest-list'] li", "[class*='related-search'] a", "[class*='related-search'] span", "[class*='recommend-query']", "[class*='hot-query']"];
    const current = String(currentKeyword || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    return unique(selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((node) => text(node))))
      .map((value) => value.normalize("NFKC").trim().replace(/\s+/g, " "))
      .filter((value) => value && value.length <= 80 && value.toLocaleLowerCase("zh-CN") !== current)
      .slice(0, 50);
  }

  const replyControlPattern = /展开.{0,8}回复|查看.{0,8}回复|更多回复|共\s*\d+\s*条回复/i;
  const rootControlPattern = /加载更多评论|查看更多评论|展开更多评论|更多评论/i;
  const actionableControls = (rootNode = document) => [...(rootNode?.querySelectorAll?.("button, [role='button'], a") || [])].filter((node) => {
    const label = text(node);
    const style = globalThis.getComputedStyle?.(node);
    const visible = !style || (style.display !== "none" && style.visibility !== "hidden");
    return visible && !node.disabled && node.dataset?.xiwAttempted !== "1" && (replyControlPattern.test(label) || rootControlPattern.test(label));
  });

  function commentSectionRoot(rootNode = document) {
    return rootNode?.querySelector?.(".comments-container, [class*='comments-container'], [class*='comments-list'], [class*='comment-list']") || null;
  }

  function scrollableDetailRoot(rootNode = document, preferCommentSection = true) {
    const commentRoot = commentSectionRoot(rootNode);
    const candidates = [
      ...(preferCommentSection && commentRoot ? [commentRoot] : []),
      ...(rootNode?.querySelectorAll?.("[class*='interaction-container'], [class*='note-scroller'], [class*='detail-content'], [role='dialog']") || []),
      rootNode
    ].filter(Boolean);
    const scrollable = candidates
      .filter((node) => isVisibleElement(node))
      .map((node) => ({ node, distance: Number(node.scrollHeight || 0) - Number(node.clientHeight || 0) }))
      .filter((item) => item.distance > 8)
      .sort((a, b) => b.distance - a.distance);
    return scrollable[0]?.node || (commentRoot && isVisibleElement(commentRoot) ? commentRoot : null);
  }

  function commentSectionEvidence(rootNode = document, comments = observedComments(rootNode), declaredTotal = declaredCommentTotal(rootNode)) {
    const sectionRoot = commentSectionRoot(rootNode);
    const emptyState = /暂无评论|还没有评论|暂时没有评论|成为第一个评论的人/.test(text(rootNode).slice(0, 12000));
    return {
      sectionRoot,
      observed: Boolean(sectionRoot || comments.length > 0 || declaredTotal !== null || emptyState),
      declaredTotal
    };
  }

  function commentTraversal(rootNode = document) {
    const comments = observedComments(rootNode);
    const evidence = commentSectionEvidence(rootNode, comments);
    const controls = actionableControls(evidence.sectionRoot || rootNode);
    const scrollRoot = scrollableDetailRoot(evidence.sectionRoot || rootNode);
    return classifyCommentTraversal(controls.map((node) => text(node)), {
      scrollHeight: Number(scrollRoot?.scrollHeight || 0),
      scrollTop: Number(scrollRoot?.scrollTop || 0),
      clientHeight: Number(scrollRoot?.clientHeight || 0)
    }, comments.length, evidence.observed, evidence.declaredTotal);
  }

  function classifyCommentTraversal(labels, scroll, visibleCommentCount = 0, sectionObserved = true, declaredTotal = null) {
    const hasScrollableEvidence = Number(scroll.scrollHeight || 0) > 0 && Number(scroll.clientHeight || 0) > 0;
    const declaredSatisfied = declaredTotal !== null && visibleCommentCount >= declaredTotal;
    const bottomReached = Boolean(sectionObserved && (
      declaredTotal === 0
      || declaredSatisfied
      || (hasScrollableEvidence && Number(scroll.scrollHeight || 0) <= Number(scroll.scrollTop || 0) + Number(scroll.clientHeight || 0) + 8)
    ));
    const expandableReplyCount = labels.filter((label) => replyControlPattern.test(label)).length;
    const hasMoreRootComments = labels.some((label) => rootControlPattern.test(label));
    return {
      sectionObserved: Boolean(sectionObserved),
      declaredCommentTotal: declaredTotal,
      visibleCommentCount,
      expandableReplyCount,
      hasMoreRootComments,
      bottomReached,
      complete: Boolean(sectionObserved) && expandableReplyCount === 0 && !hasMoreRootComments && bottomReached
    };
  }

  function advanceVisibleComments() {
    const detailRoot = visibleDetailRoot(document) || document;
    const evidence = commentSectionEvidence(detailRoot);
    const controls = actionableControls(evidence.sectionRoot || detailRoot);
    const reply = controls.find((node) => replyControlPattern.test(text(node)));
    const root = controls.find((node) => rootControlPattern.test(text(node)));
    const target = reply || root;
    if (target) {
      target.dataset.xiwAttempted = "1";
      const label = text(target).slice(0, 120);
      target.click();
      return { advanced: true, action: reply ? "EXPAND_REPLIES" : "LOAD_MORE_COMMENTS", label };
    }
    const scrollRoot = scrollableDetailRoot(evidence.sectionRoot || detailRoot, evidence.observed);
    if (!scrollRoot) return { advanced: false, action: evidence.observed ? "COMMENT_SCROLL_ROOT_NOT_FOUND" : "COMMENT_SECTION_NOT_FOUND" };
    const before = Number(scrollRoot.scrollTop || 0);
    const distance = Math.max(320, Math.round(Number(scrollRoot.clientHeight || globalThis.innerHeight || 640) * 0.8));
    if (typeof scrollRoot.scrollBy === "function") scrollRoot.scrollBy({ top: distance, behavior: "auto" });
    else scrollRoot.scrollTop = before + distance;
    return { advanced: Number(scrollRoot.scrollTop || 0) !== before, action: "SCROLL_COMMENTS", from: before, to: Number(scrollRoot.scrollTop || 0) };
  }

  function metricWithin(parent, selectors, zeroLabels = []) {
    for (const selector of selectors) {
      const nodes = parent.querySelectorAll(selector);
      for (const node of nodes) {
        // The same like-wrapper/count classes are also used by comments.
        if (node.closest(".comments-container, .comment-item, .comment-list, [class*='comment-inner'], [class*='comment-content']")) continue;
        const value = parseVisibleMetric(text(node), zeroLabels);
        if (value !== null) return value;
      }
    }
    return null;
  }

  root.XhsDetailMetric = metricWithin;

  function extractDetailAuthor(rootNode) {
    return firstText([
      "[class*='author-container'] [class~='name']",
      "[class*='author-container'] [class*='name']",
      "a[href*='/user/profile/'] [class~='name']",
      "a[href*='/user/profile/'] [class*='name']",
      ".author-name",
      ".username",
      "[class*='author-name']"
    ], rootNode);
  }

  function nodeDiagnostic(node) {
    if (!node) return null;
    return {
      tag: String(node.tagName || "").slice(0, 40),
      id: String(node.id || "").slice(0, 100),
      className: String(typeof node.className === "string" ? node.className : "").slice(0, 300),
      scrollHeight: Number(node.scrollHeight || 0),
      clientHeight: Number(node.clientHeight || 0)
    };
  }

  function capture(options = {}) {
    const url = location.href;
    const expectedNoteId = String(options?.expectedNoteId || "").trim();
    const modalRoot = visibleDetailRoot(document);
    const type = pageType(url, Boolean(modalRoot));
    const detailScope = detailScopeForCapture(url, document);
    const assets = unique([...document.querySelectorAll("img[src], video[src], video source[src]")].map((node) => node.currentSrc || node.src));
    const status = humanRequired() ? "HUMAN_REQUIRED" : type === "UNKNOWN" ? "UNKNOWN_STRUCTURE" : "VISIBLE";
    const base = {
      schemaVersion: "1.0.0",
      sourceUrl: url,
      capturedAt: new Date().toISOString(),
      pageType: type,
      status,
      title: document.title,
      visibleText: text(document.body).slice(0, 30000),
      assets: assets.slice(0, 100)
    };
    if (type === "SEARCH") {
      const keyword = searchKeyword(url);
      return { ...base, keyword, suggestions: searchSuggestions(keyword), cards: searchCards() };
    }
    if (type === "NOTE_DETAIL") {
      const detailBody = firstText(["#detail-desc", "[class*='note-content'] [class~='desc']", "[class*='note-content'] [class*='desc']", ".desc", "[class*='desc']"], detailScope);
      const observed = observedComments(detailScope);
      const comments = selectUsefulComments(observed);
      const commentEvidence = commentSectionEvidence(detailScope, observed);
      const commentScroller = scrollableDetailRoot(commentEvidence.sectionRoot || detailScope, commentEvidence.observed);
      return {
      ...base,
      noteId: url.match(/\/explore\/([^?/#]+)/)?.[1] || expectedNoteId,
      noteTitle: extractDetailTitle(detailScope, document.title, detailBody),
      authorName: extractDetailAuthor(detailScope),
      body: detailBody,
      declaredCommentTotal: commentEvidence.declaredTotal,
      metrics: {
        likes: metricWithin(detailScope, [".like-wrapper .count", "[class*='engage-bar'] [class*='like'] [class*='count']"], ["赞"]),
        collects: metricWithin(detailScope, [".collect-wrapper .count", "[class*='engage-bar'] [class*='collect'] [class*='count']"], ["收藏"]),
        comments: metricWithin(detailScope, [".chat-wrapper .count", "[class*='engage-bar'] [class*='chat'] [class*='count']", "[class*='engage-bar'] [class*='comment'] [class*='count']"], ["评论"]) ?? commentEvidence.declaredTotal,
        shares: metricWithin(detailScope, [".share-wrapper .count", "[class*='engage-bar'] [class*='share'] [class*='count']"], ["分享"])
      },
      visibleComments: comments,
      commentTraversal: {
        ...commentTraversal(detailScope),
        fetchedTotal: observed.length,
        retainedTotal: comments.length,
        filteredOutTotal: observed.length - comments.length
      },
      detailDiagnostics: {
        scope: nodeDiagnostic(detailScope),
        commentRoot: nodeDiagnostic(commentEvidence.sectionRoot),
        commentScroller: nodeDiagnostic(commentScroller),
        commentSectionObserved: commentEvidence.observed
      }
    };
    }
    return base;
  }

  root.XhsVisibleExtractor = { capture, pageType, visibleDetailRoot, detailScopeForCapture, extractDetailTitle, parseDeclaredCommentTotal, searchKeyword, parseVisibleMetric, searchCardMediaType, buildSearchCard, searchCards, mergeSearchCards, searchScrollableRoot, advanceSearchResults, openSearchCard, observedComments, mergeObservedComments, selectUsefulComments, classifyCommentTraversal, advanceVisibleComments };
})(globalThis);
