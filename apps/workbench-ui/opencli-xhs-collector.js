import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ingestBrowserSnapshot } from "../../packages/core/src/browser-snapshot-ingestion.ts";

const execFileAsync = promisify(execFile);

function asRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}_OUTPUT_NOT_ARRAY`);
  return value.filter((item) => item && typeof item === "object");
}

export function parseCliJson(stdout) {
  const input = String(stdout ?? "");
  for (let start = 0; start < input.length; start += 1) {
    const first = input[start];
    if (first !== "[" && first !== "{") continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "[" || character === "{") stack.push(character);
      else if (character === "]" || character === "}") {
        const expected = character === "]" ? "[" : "{";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try { return JSON.parse(input.slice(start, index + 1)); }
          catch { break; }
        }
      }
    }
  }
  throw new Error("OPENCLI_JSON_NOT_FOUND");
}

export function parseXhsMetric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value ?? "").trim().replaceAll(",", "").toLocaleLowerCase();
  if (!text) return null;
  if (["赞", "收藏", "评论", "转发"].includes(text)) return 0;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(万|w|千|k)?/i);
  if (!match) return null;
  const multiplier = match[2] === "万" || match[2]?.toLocaleLowerCase() === "w" ? 10_000
    : match[2] === "千" || match[2]?.toLocaleLowerCase() === "k" ? 1_000 : 1;
  return Math.max(0, Math.round(Number(match[1]) * multiplier));
}

export function extractXhsNoteId(value) {
  const match = String(value ?? "").match(/\/(?:search_result|explore|discovery|note)\/([0-9a-f]{24})(?:[/?#]|$)/i);
  return match?.[1]?.toLocaleLowerCase() ?? null;
}

export function operationalXhsNoteUrl(value) {
  const url = new URL(String(value ?? "").trim());
  if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) throw new Error("OPENCLI_NOTE_URL_HOST_INVALID");
  if (!url.searchParams.get("xsec_source")) url.searchParams.set("xsec_source", "pc_search");
  return url.href;
}

function canonicalSearchUrl(keyword) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword);
  return url.href;
}

export function buildOpenCliSearchSnapshot({ keyword, rows, capturedAt }) {
  const cards = asRows(rows, "OPENCLI_SEARCH").map((row, index) => {
    let sourceUrl = "";
    try { sourceUrl = operationalXhsNoteUrl(row.url); }
    catch { return null; }
    const noteId = extractXhsNoteId(sourceUrl);
    if (!noteId || !sourceUrl) return null;
    const title = String(row.title ?? "").trim();
    const authorName = String(row.author ?? "").trim();
    return {
      noteId,
      title,
      authorName,
      sourceUrl,
      likes: parseXhsMetric(row.likes),
      ordinal: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
      publishedAt: String(row.published_at ?? "").trim() || null,
      rawText: [title, authorName, String(row.likes ?? "").trim()].filter(Boolean).join("\n"),
    };
  }).filter(Boolean);
  return {
    schemaVersion: "opencli-xhs-visible/1.0.0",
    status: "VISIBLE",
    pageType: "SEARCH",
    sourceUrl: canonicalSearchUrl(keyword),
    keyword,
    cards,
    capturedAt,
    collector: { kind: "OPENCLI_LOGGED_IN_BROWSER", surface: "BACKGROUND", readOnly: true },
  };
}

function noteRecord(noteRows) {
  const record = {};
  for (const row of asRows(noteRows, "OPENCLI_NOTE")) {
    const field = String(row.field ?? "").trim().toLocaleLowerCase();
    if (!field) continue;
    record[field] = row.value;
  }
  return record;
}

function xhsDetailBundleExtractor(noteId, requestedCommentLimit) {
  return (async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const clean = (value) => String(value?.textContent ?? value ?? "").replace(/\s+/g, " ").trim();
    const firstText = (...selectors) => {
      for (const selector of selectors) {
        const value = clean(document.querySelector(selector));
        if (value) return value;
      }
      return "";
    };
    const bodyText = document.body?.innerText ?? "";
    const pageUrl = location.href;
    const securityBlock = /安全限制|访问链接异常/.test(bodyText)
      || /website-login\/error|error_code=300017|error_code=300031/.test(pageUrl);
    const loginWall = /登录后查看|请登录/.test(bodyText);
    const notFound = /页面不见了|笔记不存在|无法浏览/.test(bodyText);
    const pathMatch = location.pathname.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]{24})/i);
    const resolvedNoteId = pathMatch?.[1] ?? noteId;
    const state = window.__INITIAL_STATE__;
    const detailMap = state?.note?.noteDetailMap ?? state?.note?.note ?? {};
    let structuredNote = detailMap?.[resolvedNoteId]?.note ?? detailMap?.[resolvedNoteId] ?? detailMap?.[noteId]?.note ?? detailMap?.[noteId] ?? null;
    if (!structuredNote && detailMap && typeof detailMap === "object" && Object.keys(detailMap).length === 1) {
      const only = detailMap[Object.keys(detailMap)[0]];
      structuredNote = only?.note ?? only ?? null;
    }
    const interaction = structuredNote?.interactInfo ?? structuredNote?.interact_info ?? {};
    const authorData = structuredNote?.user ?? structuredNote?.author ?? {};
    const title = clean(structuredNote?.title) || firstText("#detail-title", ".note-content .title", ".title");
    const body = clean(structuredNote?.desc ?? structuredNote?.description)
      || firstText("#detail-desc", ".note-content .desc", ".note-text");
    const author = clean(authorData?.nickname ?? authorData?.nickName ?? authorData?.name)
      || firstText(".author-wrapper .username", ".author-wrapper .name", ".username");
    const tags = [];
    for (const item of Array.isArray(structuredNote?.tagList) ? structuredNote.tagList : []) {
      const name = clean(item?.name ?? item?.title ?? item);
      if (name && !tags.includes(name)) tags.push(name);
    }
    document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach((element) => {
      const name = clean(element);
      if (name && !tags.includes(name)) tags.push(name);
    });
    const metric = (structuredValue, selector) => {
      if (structuredValue !== null && structuredValue !== undefined && String(structuredValue).trim()) return structuredValue;
      return firstText(selector);
    };
    const metrics = {
      likes: metric(interaction?.likedCount ?? interaction?.likeCount, ".interact-container .like-wrapper .count"),
      collects: metric(interaction?.collectedCount ?? interaction?.collectCount, ".interact-container .collect-wrapper .count"),
      comments: metric(interaction?.commentCount, ".interact-container .chat-wrapper .count"),
      shares: metric(interaction?.shareCount, ".interact-container .share-wrapper .count"),
    };

    const media = [];
    const mediaKeys = new Set();
    const mediaHostAllowed = (hostname) => /(^|\.)(?:xhscdn|xiaohongshu|xhsstatic|rednote)\.com$/i.test(hostname);
    const pushMedia = (type, candidate) => {
      if (!candidate || typeof candidate !== "string" || candidate.startsWith("blob:") || candidate.startsWith("data:")) return;
      try {
        const parsed = new URL(candidate, location.href);
        if (!/^https?:$/.test(parsed.protocol) || !mediaHostAllowed(parsed.hostname)) return;
        const key = `${type}:${parsed.href}`;
        if (mediaKeys.has(key)) return;
        mediaKeys.add(key);
        media.push({ type, url: parsed.href });
      } catch {}
    };
    const imageList = Array.isArray(structuredNote?.imageList) ? structuredNote.imageList : [];
    for (const item of imageList) {
      pushMedia("image", item?.urlDefault ?? item?.urlPre ?? item?.url
        ?? item?.infoList?.find((entry) => entry?.imageScene === "WB_DFT")?.url
        ?? item?.infoList?.[0]?.url);
    }
    const video = structuredNote?.video;
    const streams = video?.media?.stream?.h264 ?? video?.media?.stream?.h265 ?? [];
    const videoCandidate = streams.find((stream) => stream?.masterUrl)?.masterUrl
      ?? video?.url ?? video?.originVideoKey ?? video?.consumer?.originVideoKey;
    if (videoCandidate) {
      pushMedia("video", String(videoCandidate).startsWith("http")
        ? String(videoCandidate)
        : `https://sns-video-bd.xhscdn.com/${videoCandidate}`);
    }
    if (!media.some((item) => item.type === "image")) {
      document.querySelectorAll('.swiper-slide img, .carousel-image img, .note-slider img, .note-image img, .image-wrapper img, #noteContainer .media-container img[src*="xhscdn"], img[src*="ci.xiaohongshu.com"]').forEach((element) => {
        pushMedia("image", element.currentSrc || element.src || element.getAttribute("data-src") || "");
      });
    }
    if (!media.some((item) => item.type === "video")) {
      document.querySelectorAll("video source, video[src], .player video, .video-player video").forEach((element) => {
        pushMedia("video", element.currentSrc || element.src || element.getAttribute("src") || "");
      });
    }

    const commentLimit = Math.max(1, Math.min(50, Number(requestedCommentLimit) || 50));
    const firstParentComment = document.querySelector(".parent-comment");
    const commentRoot = document.querySelector(".comments-container, .comment-list")
      || firstParentComment?.closest(".comments-container, .comment-list")
      || firstParentComment?.parentElement
      || null;
    const scroller = document.querySelector(".note-scroller") || commentRoot;
    let bottomReached = false;
    let stableRounds = 0;
    let expandedCount = 0;
    if (scroller) {
      for (let round = 0; round < 5; round += 1) {
        const beforeCount = scroller.querySelectorAll(".parent-comment").length;
        const expanders = Array.from(scroller.querySelectorAll('button, [role="button"], span, div')).filter((element) => {
          if (!(element instanceof HTMLElement) || expandedCount >= 30) return false;
          const text = clean(element);
          return text.length > 0 && text.length <= 24 && /(展开|更多回复|全部回复|查看.*回复|共\d+条回复)/.test(text);
        }).slice(0, Math.max(0, 30 - expandedCount));
        for (const element of expanders) {
          element.click();
          expandedCount += 1;
          await wait(120);
        }
        scroller.scrollTo?.(0, scroller.scrollHeight);
        await wait(650);
        const afterCount = scroller.querySelectorAll(".parent-comment").length;
        stableRounds = afterCount <= beforeCount ? stableRounds + 1 : 0;
        if (afterCount >= commentLimit || stableRounds >= 2) {
          bottomReached = stableRounds >= 2;
          break;
        }
      }
    }
    const comments = [];
    let topLevelCount = 0;
    const profile = (element) => {
      const href = element?.querySelector('a[href*="/user/profile/"]')?.getAttribute("href") ?? "";
      const match = href.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
      return { userId: match?.[1] ?? "", profileUrl: match ? `https://www.xiaohongshu.com/user/profile/${match[1]}` : "" };
    };
    for (const parent of document.querySelectorAll(".parent-comment")) {
      if (topLevelCount >= commentLimit) break;
      const item = parent.querySelector(".comment-item");
      if (!item) continue;
      const normalizedText = clean(item.querySelector(".content, .note-text"));
      if (!normalizedText) continue;
      const authorName = clean(item.querySelector(".author-wrapper .name, .user-name"));
      const identity = profile(item);
      topLevelCount += 1;
      comments.push({
        rank: comments.length + 1,
        author: authorName,
        userId: identity.userId,
        profileUrl: identity.profileUrl,
        text: normalizedText,
        likes: clean(item.querySelector(".like-wrapper .count, .count")),
        time: clean(item.querySelector(".date, .time")),
        is_reply: false,
        reply_to: "",
      });
      parent.querySelectorAll(".reply-container .comment-item-sub, .sub-comment-list .comment-item").forEach((reply) => {
        const replyText = clean(reply.querySelector(".content, .note-text"));
        if (!replyText) return;
        const replyIdentity = profile(reply);
        comments.push({
          rank: comments.length + 1,
          author: clean(reply.querySelector(".name, .user-name")),
          userId: replyIdentity.userId,
          profileUrl: replyIdentity.profileUrl,
          text: replyText,
          likes: clean(reply.querySelector(".like-wrapper .count, .count")),
          time: clean(reply.querySelector(".date, .time")),
          is_reply: true,
          reply_to: authorName,
        });
      });
    }
    return {
      pageUrl,
      noteId: resolvedNoteId,
      securityBlock,
      loginWall,
      notFound,
      detail: { title, author, body, tags, metrics },
      media,
      assetExtractionSucceeded: true,
      expectedAssetCount: media.length,
      comments,
      commentTraversal: {
        sectionObserved: Boolean(commentRoot),
        bottomReached,
        expandedCount,
      },
    };
  })();
}

export function buildXhsDetailExtractionScript(noteId, commentLimit = 50) {
  const normalizedNoteId = String(noteId ?? "").trim().toLocaleLowerCase();
  if (!/^[0-9a-f]{24}$/.test(normalizedNoteId)) throw new Error("OPENCLI_NOTE_ID_INVALID");
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(commentLimit) || 50)));
  return `(${xhsDetailBundleExtractor.toString()})(${JSON.stringify(normalizedNoteId)}, ${normalizedLimit})`;
}

export function normalizeXhsAssets(input) {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set();
  const assets = [];
  for (const value of values) {
    const record = value && typeof value === "object" ? value : { url: value };
    const sourceUrl = String(record.sourceUrl ?? record.url ?? record.src ?? "").trim();
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    if (!/(^|\.)(?:xhscdn|xiaohongshu|xhsstatic|rednote)\.com$/i.test(parsed.hostname)) continue;
    const explicitType = String(record.type ?? "").toLocaleLowerCase();
    const type = explicitType.includes("video") || /\.(?:mp4|m3u8|mov)(?:$|\?)/i.test(parsed.href) ? "VIDEO" : "IMAGE";
    const key = `${type}:${parsed.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ type, sourceUrl: parsed.href });
  }
  return assets;
}

function fieldText(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(String).join(" ").trim();
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

const genericCommentText = new Set([
  "好", "好的", "好棒", "真棒", "不错", "太好了", "厉害", "支持", "赞", "顶", "蹲", "路过", "已阅",
  "哈哈", "哈哈哈", "哈哈哈哈", "学习了", "学到了", "收藏了", "谢谢", "谢谢分享", "爱了", "绝了", "666",
]);

function compactCommentText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, "").replace(/[，。！？!?、,.~～…：:；;“”'\"（）()【】\[\]]+/g, "");
}

function commentDemandReasons(text) {
  const reasons = [];
  if (/[?？]|怎么|如何|为什么|哪里|哪儿|哪个|有没有|能不能|是否|可以吗|请问|求问|想知道/.test(text)) reasons.push("QUESTION_OR_INFORMATION_NEED");
  if (/需要|想要|希望|求|推荐|链接|教程|步骤|清单|模板|价格|多少钱|怎么买|购买|报名|合作|联系/.test(text)) reasons.push("EXPLICIT_DEMAND_OR_ACTION_INTENT");
  if (/不会|不懂|困难|痛点|问题|失败|卡住|解决|怎么办|适合|建议/.test(text)) reasons.push("PAIN_POINT_OR_HELP_NEED");
  if (/但是|不过|担心|缺点|避坑|踩坑|风险|太贵|没用|不行|不同意|不建议/.test(text)) reasons.push("OBJECTION_OR_RISK_SIGNAL");
  return reasons;
}

function valuelessComment(text) {
  const compact = compactCommentText(text);
  if (!compact || genericCommentText.has(compact)) return true;
  if (/^[\p{P}\p{S}\p{N}]+$/u.test(compact)) return true;
  return compact.length <= 2 && commentDemandReasons(compact).length === 0;
}

export function selectUsefulComments(comments) {
  const source = asRows(comments, "OPENCLI_NORMALIZED_COMMENTS");
  const positiveLikes = source.map((comment) => parseXhsMetric(comment.likes) ?? 0).filter((likes) => likes > 0).sort((a, b) => b - a);
  const agreementIndex = positiveLikes.length ? Math.ceil((positiveLikes.length - 1) * 0.25) : -1;
  const agreementFloor = agreementIndex >= 0 ? Math.max(2, positiveLikes[agreementIndex]) : Number.POSITIVE_INFINITY;
  const seenText = new Set();
  const selected = [];
  for (const comment of source) {
    const text = String(comment.text ?? comment.rawText ?? "").trim();
    const compact = compactCommentText(text);
    if (valuelessComment(text) || seenText.has(compact)) continue;
    const likes = parseXhsMetric(comment.likes) ?? 0;
    const reasons = commentDemandReasons(text);
    if (likes >= agreementFloor) reasons.unshift("HIGH_AGREEMENT");
    if (!reasons.length) continue;
    seenText.add(compact);
    selected.push({
      ...comment,
      likes: parseXhsMetric(comment.likes),
      selectionReasons: [...new Set(reasons)],
      valueScore: Math.min(100, reasons.length * 24 + Math.round(Math.log10(likes + 1) * 18)),
    });
  }
  const retainedAuthors = new Set(selected.filter((comment) => comment.isReply !== true).map((comment) => String(comment.author ?? "").trim()).filter(Boolean));
  for (const comment of source) {
    const text = String(comment.text ?? comment.rawText ?? "").trim();
    const compact = compactCommentText(text);
    const replyTo = String(comment.replyTo ?? "").trim();
    if (comment.isReply !== true || !retainedAuthors.has(replyTo) || valuelessComment(text) || seenText.has(compact)) continue;
    seenText.add(compact);
    selected.push({ ...comment, likes: parseXhsMetric(comment.likes), selectionReasons: ["REPLY_CONTEXT_FOR_RETAINED_COMMENT"], valueScore: 18 });
  }
  return selected.sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0) || (b.likes ?? 0) - (a.likes ?? 0) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

export function buildOpenCliDetailSnapshot({
  sourceUrl,
  noteId,
  noteRows,
  commentRows = [],
  assets = [],
  assetExtractionSucceeded = false,
  expectedAssetCount = null,
  capturedAt,
  commentLimit = 50,
  commentFetchSucceeded = true,
  commentFetchSkippedBecauseZero = false,
  commentSectionObserved = true,
  commentBottomReached = false,
}) {
  const record = noteRecord(noteRows);
  const declaredTotal = parseXhsMetric(record.comments);
  const rows = asRows(commentRows, "OPENCLI_COMMENTS");
  const fetchedComments = rows.map((row, index) => ({
    ordinal: Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1,
    author: String(row.author ?? "").trim(),
    authorUserId: String(row.userId ?? row.user_id ?? "").trim() || null,
    profileUrl: String(row.profileUrl ?? row.profile_url ?? "").trim() || null,
    text: String(row.text ?? "").trim(),
    rawText: String(row.text ?? "").trim(),
    likes: parseXhsMetric(row.likes),
    publishedAt: String(row.time ?? "").trim() || null,
    isReply: row.is_reply === true || row.isReply === true,
    replyTo: String(row.reply_to ?? row.replyTo ?? "").trim() || null,
  })).filter((comment) => comment.text || comment.rawText);
  const visibleComments = selectUsefulComments(fetchedComments);
  const fetchedTopLevel = fetchedComments.filter((comment) => !comment.isReply).length;
  const fetchedReplies = fetchedComments.length - fetchedTopLevel;
  const capturedTopLevel = visibleComments.filter((comment) => !comment.isReply).length;
  const capturedReplies = visibleComments.length - capturedTopLevel;
  const complete = declaredTotal !== null && declaredTotal <= commentLimit && fetchedComments.length >= declaredTotal;
  const commentCoverageSatisfied = commentFetchSucceeded && (declaredTotal === 0 || declaredTotal === null || fetchedComments.length > 0);
  const noteTitle = fieldText(record, "title", "标题");
  const authorName = fieldText(record, "author", "作者");
  const body = fieldText(record, "content", "body", "正文");
  const metrics = {
    likes: parseXhsMetric(record.likes),
    collects: parseXhsMetric(record.collects),
    comments: declaredTotal,
    shares: parseXhsMetric(record.shares),
  };
  const normalizedAssets = normalizeXhsAssets(assets);
  const declaredAssetCount = Number.isFinite(Number(expectedAssetCount)) ? Math.max(0, Math.floor(Number(expectedAssetCount))) : null;
  const admissionReasons = [];
  if (!noteTitle) admissionReasons.push("DETAIL_TITLE_MISSING");
  if (!authorName) admissionReasons.push("DETAIL_AUTHOR_MISSING");
  if (!body) admissionReasons.push("DETAIL_BODY_MISSING");
  if (Object.values(metrics).some((value) => value === null)) admissionReasons.push("DETAIL_METRICS_INCOMPLETE");
  if (declaredTotal === null) admissionReasons.push("COMMENT_TOTAL_NOT_OBSERVED");
  if (!commentFetchSucceeded) admissionReasons.push("COMMENT_FETCH_FAILED");
  if (declaredTotal !== null && declaredTotal > 0 && fetchedComments.length === 0) admissionReasons.push("DECLARED_COMMENTS_NOT_CAPTURED");
  if (!assetExtractionSucceeded) admissionReasons.push("ASSET_EXTRACTION_NOT_CONFIRMED");
  if (assetExtractionSucceeded && normalizedAssets.length === 0) admissionReasons.push("DETAIL_ASSETS_NOT_CAPTURED");
  if (declaredAssetCount !== null && declaredAssetCount !== normalizedAssets.length) admissionReasons.push("DETAIL_ASSET_COUNT_MISMATCH");
  const admissionStatus = admissionReasons.length ? "REJECTED" : "ADMITTED";
  return {
    schemaVersion: "opencli-xhs-visible/1.0.0",
    status: "VISIBLE",
    pageType: "NOTE_DETAIL",
    sourceUrl,
    noteId,
    noteTitle,
    authorName,
    body,
    tags: fieldText(record, "tags", "标签").split(/\s+/).filter(Boolean),
    metrics,
    assets: normalizedAssets,
    assetExtractionSucceeded,
    expectedAssetCount: declaredAssetCount,
    visibleComments,
    commentTraversal: {
      sectionObserved: commentSectionObserved,
      declaredTotal,
      fetchedTotal: fetchedComments.length,
      fetchedTopLevel,
      fetchedReplies,
      retainedTotal: visibleComments.length,
      filteredOutTotal: fetchedComments.length - visibleComments.length,
      capturedTotal: visibleComments.length,
      capturedTopLevel,
      capturedReplies,
      limit: commentLimit,
      complete,
      bottomReached: complete || commentBottomReached,
      commentFetchSucceeded,
      commentFetchSkippedBecauseZero,
      commentCoverageSatisfied,
      retentionPolicy: "DUAL_SIGNAL_HIGH_AGREEMENT_OR_DEMAND_V1",
    },
    admission: { status: admissionStatus, reasons: admissionReasons },
    capturedAt,
    collector: { kind: "OPENCLI_LOGGED_IN_BROWSER", surface: "BACKGROUND", readOnly: true },
  };
}

function openCliEntry() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA_NOT_AVAILABLE");
  return path.join(appData, "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
}

export async function runOpenCliJson(commandArgs, { profile, timeoutMs = 120_000 } = {}) {
  const stdout = await runOpenCliText(commandArgs, { profile, timeoutMs });
  return parseCliJson(stdout);
}

export async function runOpenCliText(commandArgs, { profile, timeoutMs = 120_000 } = {}) {
  if (!profile) throw new Error("OPENCLI_PROFILE_REQUIRED");
  const { stdout } = await execFileAsync(process.execPath, [openCliEntry(), "--profile", profile, ...commandArgs], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", OPENCLI_BROWSER_COMMAND_TIMEOUT: String(openCliBrowserTimeoutSeconds(timeoutMs)) },
  });
  return stdout;
}

export async function collectXhsDetailBundle({
  sourceUrl,
  noteId,
  commentLimit = 50,
  profile,
  runJson = runOpenCliJson,
  runText = runOpenCliText,
  sessionName,
} = {}) {
  const operationalUrl = operationalXhsNoteUrl(sourceUrl);
  const stableNoteId = extractXhsNoteId(operationalUrl) ?? String(noteId ?? "").trim().toLocaleLowerCase();
  const session = sessionName ?? `xhs-note-${stableNoteId.slice(-8)}-${Date.now().toString(36)}`;
  let opened = false;
  try {
    await runJson(["browser", session, "open", operationalUrl, "--window", "background"], { profile, timeoutMs: 120_000 });
    opened = true;
    const bundle = await runJson(["browser", session, "eval", buildXhsDetailExtractionScript(stableNoteId, commentLimit)], { profile, timeoutMs: 180_000 });
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("OPENCLI_DETAIL_BUNDLE_MALFORMED");
    if (bundle.securityBlock) throw new Error("OPENCLI_SECURITY_BLOCK");
    if (bundle.loginWall) throw new Error("OPENCLI_AUTH_REQUIRED");
    if (bundle.notFound) throw new Error("OPENCLI_NOTE_NOT_FOUND");
    if (!bundle.detail || typeof bundle.detail !== "object") throw new Error("OPENCLI_DETAIL_BUNDLE_MISSING_DETAIL");
    return bundle;
  } finally {
    if (opened) {
      try { await runText(["browser", session, "close"], { profile, timeoutMs: 30_000 }); }
      catch { /* Closing an isolated background lease must not hide the collection result. */ }
    }
  }
}

export function openCliBrowserTimeoutSeconds(timeoutMs) {
  return Math.max(60, Math.floor(Math.max(60_000, Number(timeoutMs) || 120_000) / 1000) - 15);
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error ?? "OPENCLI_COLLECTION_FAILED")
    .replace(/xsec_token=[^&\s'"\]]+/gi, "xsec_token=[redacted]")
    .replace(/https:\/\/www\.xiaohongshu\.com\/[^\s'"\]]+/gi, "[xiaohongshu-url]")
    .slice(0, 500);
}

export async function persistOpenCliSnapshot(snapshot, { databasePath, snapshotRoot, projectRoot, ingest = ingestBrowserSnapshot } = {}) {
  if (!databasePath || !snapshotRoot || !projectRoot) throw new Error("OPENCLI_PERSISTENCE_PATHS_REQUIRED");
  const serialized = JSON.stringify(snapshot);
  const fingerprint = createHash("sha256").update(serialized, "utf8").digest("hex");
  const identity = snapshot.noteId ?? snapshot.keyword ?? snapshot.pageType;
  const safeIdentity = String(identity).normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "snapshot";
  const receiptId = `opencli-${Date.now()}-${safeIdentity}-${fingerprint.slice(0, 10)}`;
  const directory = path.join(snapshotRoot, "opencli");
  const snapshotPath = path.join(directory, `${receiptId}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  if (snapshot.pageType === "NOTE_DETAIL" && snapshot.admission?.status !== "ADMITTED") {
    return { receiptId, fingerprint, snapshotPath: path.relative(projectRoot, snapshotPath), ingestion: { status: "REJECTED_AT_ADMISSION_GATE", normalizedNoteIds: [], rankingSnapshotIds: [] } };
  }
  const ingestion = await ingest({
    receipt: { receiptId, fingerprint, snapshotPath: path.relative(projectRoot, snapshotPath), snapshot },
    databasePath,
    ingestedAt: new Date().toISOString(),
  });
  return { receiptId, fingerprint, snapshotPath: path.relative(projectRoot, snapshotPath), ingestion };
}

export async function collectXhsKeyword({
  keyword,
  profile,
  searchLimit = 20,
  detailLimit = 3,
  commentLimit = 50,
  existingNoteIds = [],
  runCli = runOpenCliJson,
  runText = runOpenCliText,
  runDetailBundle = runCli === runOpenCliJson ? collectXhsDetailBundle : null,
  persistAndIngest,
  databasePath,
  snapshotRoot,
  projectRoot,
  now = () => new Date().toISOString(),
  onProgress,
} = {}) {
  const normalizedKeyword = String(keyword ?? "").trim();
  if (!normalizedKeyword) throw new Error("OPENCLI_KEYWORD_REQUIRED");
  const persist = persistAndIngest ?? ((snapshot) => persistOpenCliSnapshot(snapshot, { databasePath, snapshotRoot, projectRoot }));
  await onProgress?.({ phase: "SEARCH", completed: 0, total: 1 });
  const searchRows = asRows(await runCli([
    "xiaohongshu", "search", normalizedKeyword,
    "--limit", String(searchLimit), "--window", "background", "--site-session", "ephemeral", "--keep-tab", "false", "-f", "json",
  ], { profile, timeoutMs: 120_000 }), "OPENCLI_SEARCH");
  const searchSnapshot = buildOpenCliSearchSnapshot({ keyword: normalizedKeyword, rows: searchRows, capturedAt: now() });
  if (!searchSnapshot.cards.length) throw new Error("OPENCLI_SEARCH_RETURNED_NO_USABLE_CARDS");
  const searchReceipt = await persist(searchSnapshot);
  const existing = new Set(existingNoteIds);
  const byEngagement = (cards) => [...cards].sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1) || a.ordinal - b.ordinal);
  const candidates = [
    ...byEngagement(searchSnapshot.cards.filter((card) => !existing.has(card.noteId))),
    ...byEngagement(searchSnapshot.cards.filter((card) => existing.has(card.noteId))),
  ];
  const targetBudget = Math.min(Math.max(0, detailLimit), candidates.length);
  const maxAttempts = Math.min(candidates.length, Math.max(targetBudget, targetBudget * 3));
  const errors = [];
  const normalizedNoteIds = [];
  const detailReceipts = [];
  const rejectedDetailReceipts = [];
  let capturedCommentCount = 0;
  let fetchedCommentCount = 0;
  let filteredOutCommentCount = 0;
  let detailAttempted = 0;
  for (const card of candidates.slice(0, maxAttempts)) {
    if (detailReceipts.length >= targetBudget) break;
    await onProgress?.({ phase: "DETAIL", completed: detailReceipts.length, total: targetBudget, attempted: detailAttempted, noteId: card.noteId });
    detailAttempted += 1;
    try {
      let noteRows;
      let commentRows = [];
      let commentFetchSucceeded = true;
      let commentFetchSkippedBecauseZero = false;
      let assets = [];
      let assetExtractionSucceeded = false;
      let expectedAssetCount = null;
      let commentSectionObserved = true;
      let commentBottomReached = false;
      if (typeof runDetailBundle === "function") {
        const bundle = await runDetailBundle({
          sourceUrl: card.sourceUrl,
          noteId: card.noteId,
          commentLimit,
          profile,
          runJson: runCli,
          runText,
        });
        const detail = bundle?.detail ?? {};
        const metrics = detail.metrics ?? {};
        noteRows = [
          { field: "title", value: detail.title ?? "" },
          { field: "author", value: detail.author ?? "" },
          { field: "content", value: detail.body ?? "" },
          { field: "likes", value: metrics.likes ?? "" },
          { field: "collects", value: metrics.collects ?? "" },
          { field: "comments", value: metrics.comments ?? "" },
          { field: "shares", value: metrics.shares ?? "" },
          { field: "tags", value: Array.isArray(detail.tags) ? detail.tags.join(" ") : detail.tags ?? "" },
        ];
        commentRows = asRows(bundle.comments ?? [], "OPENCLI_COMMENTS");
        assets = bundle.media ?? [];
        assetExtractionSucceeded = bundle.assetExtractionSucceeded === true;
        expectedAssetCount = bundle.expectedAssetCount;
        commentSectionObserved = bundle.commentTraversal?.sectionObserved === true;
        commentBottomReached = bundle.commentTraversal?.bottomReached === true;
      } else {
        noteRows = asRows(await runCli([
          "xiaohongshu", "note", card.sourceUrl,
          "--window", "background", "--site-session", "ephemeral", "--keep-tab", "false", "-f", "json",
        ], { profile, timeoutMs: 120_000 }), "OPENCLI_NOTE");
      }
      const declaredCommentTotal = parseXhsMetric(noteRecord(noteRows).comments);
      commentFetchSkippedBecauseZero = declaredCommentTotal === 0;
      if (typeof runDetailBundle === "function") {
        commentFetchSucceeded = commentFetchSkippedBecauseZero || commentSectionObserved;
      } else if (!commentFetchSkippedBecauseZero) {
        try {
          commentRows = asRows(await runCli([
            "xiaohongshu", "comments", card.sourceUrl,
            "--limit", String(commentLimit), "--with-replies", "true", "--window", "background", "--site-session", "ephemeral", "--keep-tab", "false", "-f", "json",
          ], { profile, timeoutMs: 180_000 }), "OPENCLI_COMMENTS");
        } catch (error) {
          commentFetchSucceeded = false;
          errors.push({ noteId: card.noteId, stage: "COMMENTS", error: safeError(error) });
        }
      }
      const detailSnapshot = buildOpenCliDetailSnapshot({
        sourceUrl: card.sourceUrl,
        noteId: card.noteId,
        noteRows,
        commentRows,
        assets,
        assetExtractionSucceeded,
        expectedAssetCount,
        capturedAt: now(),
        commentLimit,
        commentFetchSucceeded,
        commentFetchSkippedBecauseZero,
        commentSectionObserved,
        commentBottomReached,
      });
      const receipt = await persist(detailSnapshot);
      const receiptSummary = { receiptId: receipt.receiptId, noteId: card.noteId, fetchedCommentCount: detailSnapshot.commentTraversal.fetchedTotal, retainedCommentCount: detailSnapshot.visibleComments.length, admission: detailSnapshot.admission };
      if (detailSnapshot.admission.status === "ADMITTED") {
        detailReceipts.push(receiptSummary);
        normalizedNoteIds.push(...(receipt.ingestion?.normalizedNoteIds ?? []));
        capturedCommentCount += detailSnapshot.visibleComments.length;
        fetchedCommentCount += detailSnapshot.commentTraversal.fetchedTotal;
        filteredOutCommentCount += detailSnapshot.commentTraversal.filteredOutTotal;
      } else {
        rejectedDetailReceipts.push(receiptSummary);
        errors.push({ noteId: card.noteId, stage: "ADMISSION", error: detailSnapshot.admission.reasons.join(",") });
      }
    } catch (error) {
      errors.push({ noteId: card.noteId, stage: "DETAIL", error: safeError(error) });
    }
  }
  await onProgress?.({ phase: "COMPLETE", completed: detailReceipts.length, total: targetBudget, attempted: detailAttempted });
  return {
    status: detailReceipts.length >= targetBudget ? "SUCCEEDED" : "PARTIAL",
    keyword: normalizedKeyword,
    searchReceiptId: searchReceipt.receiptId,
    rankingSnapshotId: searchReceipt.ingestion?.rankingSnapshotIds?.[0] ?? null,
    searchCardCount: searchSnapshot.cards.length,
    searchCards: searchSnapshot.cards.map(({ noteId, title, authorName, likes, ordinal, publishedAt }) => ({ noteId, title, authorName, likes, ordinal, publishedAt })),
    detailAttempted,
    detailSucceeded: detailReceipts.length,
    capturedCommentCount,
    fetchedCommentCount,
    filteredOutCommentCount,
    normalizedNoteIds: [...new Set(normalizedNoteIds)],
    detailReceipts,
    rejectedDetailReceipts,
    errors,
    finishedAt: now(),
  };
}
