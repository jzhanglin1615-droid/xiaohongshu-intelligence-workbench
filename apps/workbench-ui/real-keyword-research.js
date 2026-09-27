import { createHash, randomUUID } from "node:crypto";

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"]);
const GENERIC_TITLE_PARTS = new Set([
  "一定要看", "建议收藏", "干货分享", "真的绝了", "太好用了", "谁懂啊", "救命", "来了", "分享", "合集",
]);
const INTENT_SUFFIXES = ["新手", "教程", "避坑", "怎么做", "清单", "测评", "推荐"];

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

export function normalizeResearchSettings(input = {}) {
  return {
    maxDepth: boundedInteger(input.maxDepth, 1, 0, 3),
    maxKeywords: boundedInteger(input.maxKeywords, 300, 1, 300),
    maxChildrenPerKeyword: boundedInteger(input.maxChildrenPerKeyword, 5, 1, 12),
    searchLimit: boundedInteger(input.searchLimit, 1500, 20, 1500),
    notesPerKeyword: boundedInteger(input.notesPerKeyword, 5, 1, 12),
    commentLimit: boundedInteger(input.commentLimit, 50, 1, 50),
    requestIntervalMs: boundedInteger(input.requestIntervalMs, 1500, 1000, 60_000),
    reuseExistingNotes: input.reuseExistingNotes !== false,
    expandFromResults: input.expandFromResults !== false,
  };
}

export function normalizeResearchSeeds(input) {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n/);
  const seen = new Set();
  const seeds = [];
  for (const raw of values) {
    const value = String(raw ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = value.toLocaleLowerCase("zh-CN");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    seeds.push(value);
  }
  return seeds;
}

function keywordId(value) {
  return `kw-${createHash("sha256").update(value.toLocaleLowerCase("zh-CN"), "utf8").digest("hex").slice(0, 16)}`;
}

function queueEntry(value, depth, parentKeywordId, ordinal) {
  return {
    keywordId: keywordId(value), value, depth, parentKeywordId, ordinal,
    status: "QUEUED", cardCount: 0, attemptedNotes: 0, savedNotes: 0,
    fetchedComments: 0, retainedComments: 0, filteredComments: 0, rejectedNotes: 0,
    normalizedNoteIds: [], topCards: [], errors: [], startedAt: null, finishedAt: null,
  };
}

export function createRealKeywordResearchRun({ seeds, settings, now = new Date().toISOString(), runId = `research-${randomUUID()}` } = {}) {
  const normalizedSeeds = normalizeResearchSeeds(seeds);
  if (!normalizedSeeds.length) throw new Error("RESEARCH_SEED_REQUIRED");
  const normalizedSettings = normalizeResearchSettings(settings);
  const acceptedSeeds = normalizedSeeds.slice(0, normalizedSettings.maxKeywords);
  const queue = acceptedSeeds.map((value, index) => queueEntry(value, 0, null, index + 1));
  return {
    runId,
    status: "QUEUED",
    phase: "等待开始",
    seeds: acceptedSeeds,
    settings: normalizedSettings,
    queue,
    currentKeywordId: null,
    currentKeyword: null,
    control: { pauseRequested: false, cancelRequested: false },
    counters: {
      totalKeywords: queue.length, completedKeywords: 0, discoveredKeywords: 0,
      cardCandidates: 0, attemptedNotes: 0, savedNotes: 0,
      fetchedComments: 0, retainedComments: 0, filteredComments: 0,
      rejectedNotes: 0, failedKeywords: 0,
    },
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    lastError: null,
  };
}

export function isResearchRunActive(run) {
  return Boolean(run && ACTIVE_STATUSES.has(run.status));
}

export function nextResearchKeyword(run) {
  return run?.queue?.find((item) => item.status === "QUEUED") ?? null;
}

function cleanTitleCandidate(title) {
  return String(title ?? "")
    .normalize("NFKC")
    .replace(/#[^#\s]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, " ")
    .replace(/[“”‘’【】\[\]（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateParts(title) {
  const cleaned = cleanTitleCandidate(title);
  if (!cleaned) return [];
  const parts = cleaned.split(/[，。！？!?,、|｜:：;；—\-]/).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length <= 24) parts.unshift(cleaned);
  return parts.filter((value) => value.length >= 2 && value.length <= 24 && !GENERIC_TITLE_PARTS.has(value));
}

export function discoverRelatedKeywords({ parentKeyword, cards = [], existingKeywords = [], limit = 5 } = {}) {
  const parent = String(parentKeyword ?? "").normalize("NFKC").trim();
  if (!parent) return [];
  const existing = new Set(normalizeResearchSeeds([...existingKeywords, parent]).map((value) => value.toLocaleLowerCase("zh-CN")));
  const scored = new Map();
  for (const card of cards) {
    const likes = Math.max(0, Number(card?.likes ?? 0));
    for (const value of candidateParts(card?.title)) {
      const key = value.toLocaleLowerCase("zh-CN");
      if (existing.has(key) || value === parent) continue;
      const overlap = value.includes(parent) ? 20 : 0;
      const score = overlap + Math.log10(likes + 1) * 8 + Math.max(0, 24 - value.length) / 8;
      if (score > (scored.get(key)?.score ?? -Infinity)) scored.set(key, { value, score, source: "REAL_TITLE" });
    }
  }
  for (const suffix of INTENT_SUFFIXES) {
    const value = `${parent} ${suffix}`;
    const key = value.toLocaleLowerCase("zh-CN");
    if (!existing.has(key) && !scored.has(key)) scored.set(key, { value, score: 4, source: "INTENT_PATTERN" });
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value, "zh-CN"))
    .slice(0, boundedInteger(limit, 5, 1, 12));
}

export function appendDiscoveredKeywords(run, parent, candidates, now = new Date().toISOString()) {
  if (!run.settings.expandFromResults || parent.depth >= run.settings.maxDepth) return [];
  const existing = new Set(run.queue.map((item) => item.value.toLocaleLowerCase("zh-CN")));
  const added = [];
  for (const candidate of candidates) {
    const value = String(candidate?.value ?? candidate ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = value.toLocaleLowerCase("zh-CN");
    if (!value || existing.has(key) || run.queue.length >= run.settings.maxKeywords) continue;
    existing.add(key);
    const entry = queueEntry(value, parent.depth + 1, parent.keywordId, run.queue.length + 1);
    entry.discoverySource = String(candidate?.source ?? "RESULT");
    entry.discoveredAt = now;
    run.queue.push(entry);
    added.push(entry);
    if (added.length >= run.settings.maxChildrenPerKeyword) break;
  }
  run.counters.discoveredKeywords += added.length;
  run.counters.totalKeywords = run.queue.length;
  run.updatedAt = now;
  return added;
}

export function applyKeywordResult(run, keyword, result, now = new Date().toISOString()) {
  keyword.status = result.status === "SUCCEEDED" ? "SUCCEEDED" : "PARTIAL";
  keyword.cardCount = Number(result.searchCardCount ?? 0);
  keyword.attemptedNotes = Number(result.detailAttempted ?? 0);
  keyword.savedNotes = Number(result.detailSucceeded ?? 0);
  keyword.fetchedComments = Number(result.fetchedCommentCount ?? 0);
  keyword.retainedComments = Number(result.capturedCommentCount ?? 0);
  keyword.filteredComments = Number(result.filteredOutCommentCount ?? 0);
  keyword.rejectedNotes = Number(result.rejectedDetailReceipts?.length ?? 0);
  keyword.normalizedNoteIds = [...new Set(result.normalizedNoteIds ?? [])];
  keyword.topCards = (result.searchCards ?? []).slice(0, 12).map((card) => ({
    noteId: String(card.noteId ?? ""),
    title: String(card.title ?? ""),
    authorName: String(card.authorName ?? ""),
    likes: Math.max(0, Number(card.likes ?? 0)),
    ordinal: Number(card.ordinal ?? 0),
    publishedAt: card.publishedAt ?? null,
  }));
  keyword.errors = result.errors ?? [];
  keyword.finishedAt = now;
  run.counters.completedKeywords += 1;
  run.counters.cardCandidates += keyword.cardCount;
  run.counters.attemptedNotes += keyword.attemptedNotes;
  run.counters.savedNotes += keyword.savedNotes;
  run.counters.fetchedComments += keyword.fetchedComments;
  run.counters.retainedComments += keyword.retainedComments;
  run.counters.filteredComments += keyword.filteredComments;
  run.counters.rejectedNotes += keyword.rejectedNotes;
  run.updatedAt = now;
  return run;
}

export function rebuildResearchInsights(run) {
  const authors = new Map();
  const keywordOpportunities = [];
  for (const keyword of run?.queue ?? []) {
    if (!["SUCCEEDED", "PARTIAL"].includes(keyword.status)) continue;
    keywordOpportunities.push({
      keywordId: keyword.keywordId,
      keyword: keyword.value,
      depth: keyword.depth,
      cardCount: keyword.cardCount,
      savedNotes: keyword.savedNotes,
      retainedComments: keyword.retainedComments,
      score: keyword.cardCount * 2 + keyword.savedNotes * 12 + keyword.retainedComments * 3,
    });
    for (const card of keyword.topCards ?? []) {
      if (!card.authorName) continue;
      const current = authors.get(card.authorName) ?? { authorName: card.authorName, appearances: 0, totalLikes: 0, keywords: new Set(), topTitles: [] };
      current.appearances += 1;
      current.totalLikes += Math.max(0, Number(card.likes ?? 0));
      current.keywords.add(keyword.value);
      if (card.title && current.topTitles.length < 3 && !current.topTitles.includes(card.title)) current.topTitles.push(card.title);
      authors.set(card.authorName, current);
    }
  }
  run.insights = {
    competitorAccounts: [...authors.values()]
      .map((item) => ({ ...item, keywords: [...item.keywords] }))
      .sort((a, b) => b.appearances - a.appearances || b.totalLikes - a.totalLikes)
      .slice(0, 20),
    keywordOpportunities: keywordOpportunities
      .sort((a, b) => b.score - a.score || b.savedNotes - a.savedNotes)
      .slice(0, 30),
    generatedAt: new Date().toISOString(),
  };
  return run.insights;
}

export function applyKeywordFailure(run, keyword, error, now = new Date().toISOString()) {
  const normalizedError = sanitizeResearchError(error);
  keyword.status = "FAILED";
  keyword.errors = [{ stage: "KEYWORD", code: normalizedError.code, error: normalizedError.message }];
  keyword.finishedAt = now;
  run.counters.completedKeywords += 1;
  run.counters.failedKeywords += 1;
  run.lastError = keyword.errors[0].error;
  run.updatedAt = now;
  return run;
}

export function sanitizeResearchError(error) {
  const raw = String(error instanceof Error ? error.message : error ?? "RESEARCH_FAILED");
  if (/Detached while handling command|detached_mid_command/i.test(raw)) {
    return { code: "BROWSER_SESSION_DETACHED", message: "浏览器连接在读取过程中中断，本轮没有入库" };
  }
  if (/timed out|ETIMEDOUT|TIMEOUT/i.test(raw)) {
    return { code: "PLATFORM_READ_TIMEOUT", message: "平台读取超时，本轮没有入库" };
  }
  if (/OPENCLI_SEARCH_RETURNED_NO_USABLE_CARDS/i.test(raw)) {
    return { code: "NO_USABLE_RESULTS", message: "本次搜索没有取得可用作品，本轮没有入库" };
  }
  const safe = raw
    .replace(/xsec_token=[^&\s'"\]]+/gi, "xsec_token=[redacted]")
    .replace(/https:\/\/www\.xiaohongshu\.com\/[^\s'"\]]+/gi, "[xiaohongshu-url]")
    .replace(/[A-Za-z]:\\[^\r\n]+/g, "[local-command]")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean) ?? "采集失败，本轮没有入库";
  return { code: "RESEARCH_KEYWORD_FAILED", message: safe.slice(0, 180) };
}

export function sanitizeStoredResearchRun(run) {
  if (!run) return run;
  const safeRun = structuredClone(run);
  safeRun.queue = (safeRun.queue ?? []).map((item) => ({
    ...item,
    errors: (item.errors ?? []).map((entry) => {
      const normalized = sanitizeResearchError(entry?.error ?? entry?.message ?? entry);
      return {
        stage: entry?.stage ?? "KEYWORD",
        code: normalized.code === "RESEARCH_KEYWORD_FAILED" && entry?.code ? entry.code : normalized.code,
        error: normalized.message,
      };
    }),
  }));
  if (safeRun.lastError) safeRun.lastError = sanitizeResearchError(safeRun.lastError).message;
  return safeRun;
}

export function publicResearchRun(run) {
  if (!run) return null;
  return structuredClone({ ...run, control: undefined });
}
