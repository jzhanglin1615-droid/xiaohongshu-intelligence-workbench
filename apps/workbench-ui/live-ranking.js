import { metricSeries, validMetric } from "./chart-data.js";
const metric = (value) => validMetric(value) ? value : null;

export function admittedWorkbenchNoteIds(database) {
  return new Set((Array.isArray(database?.notes) ? database.notes : [])
    .filter((note) => note?.noteId && note?.title)
    .map((note) => note.noteId));
}

function reasonFor(signal, metrics) {
  const reasons = [];
  if (signal?.kind === "NEW_ENTRY") reasons.push("新上榜，先看选题和开头");
  else if (signal?.kind === "REENTERED") reasons.push("重新上榜，值得复盘触发点");
  else if (signal?.kind === "RISING") reasons.push(`上升 ${signal.rankDelta} 位，优先查看`);
  else if (signal?.kind === "UNCHANGED") reasons.push("持续在榜，观察可复用结构");
  else if (signal?.kind === "FALLING") reasons.push("排名回落，谨慎跟进");
  const likes = metric(metrics?.likes);
  const collects = metric(metrics?.collects);
  if (likes !== null && likes > 0 && collects !== null && collects / likes >= 0.2) reasons.push("收藏意图较强");
  return reasons.slice(0, 2).join("；") || "已有在榜证据，建议打开原文判断";
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function opportunityScore(metrics) {
  const likes = metric(metrics?.likes) ?? 0;
  const collects = metric(metrics?.collects) ?? 0;
  const shares = metric(metrics?.shares) ?? 0;
  return likes + collects * 3 + shares * 4;
}

const metricKeys = ["likes", "collects", "comments", "shares"];

function metricSnapshot(observedAt, values, source) {
  const metrics = Object.fromEntries(metricKeys.map((key) => [key, metric(values?.[key])]));
  if (metricKeys.every((key) => metrics[key] === null)) return null;
  return { observedAt, source, ...metrics };
}

function metricTimeline(database, noteId) {
  const history = [];
  for (const envelope of Array.isArray(database?.rawEnvelopes) ? database.rawEnvelopes : []) {
    if (envelope?.kind === "SEARCH_RESULTS" && Array.isArray(envelope?.payload?.cards)) {
      const card = envelope.payload.cards.find((item) => item?.noteId === noteId);
      const snapshot = card ? metricSnapshot(envelope.collectedAt, { likes: card.likes, collects: card.collects, shares: card.shares }, "SEARCH_RESULTS") : null;
      if (snapshot) history.push(snapshot);
    }
    if (envelope?.kind === "NOTE_DETAIL" && envelope?.payload?.noteId === noteId) {
      const snapshot = metricSnapshot(envelope.collectedAt, envelope.payload.metrics, "NOTE_DETAIL");
      if (snapshot) history.push(snapshot);
    }
  }
  const note = (Array.isArray(database?.notes) ? database.notes : []).find((item) => item?.noteId === noteId);
  const normalized = note ? metricSnapshot(note.metrics?.observedAt, note.metrics, "NORMALIZED_NOTE") : null;
  if (normalized) history.push(normalized);
  return history.filter((item) => timestamp(item.observedAt) > 0).sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt));
}

function currentMetrics(history) {
  return Object.fromEntries(metricKeys.map(key => [key, metricSeries(history, key).at(-1)?.value ?? null]));
}

function metricChanges(history) {
  return Object.fromEntries(metricKeys.map((key) => {
    const points = metricSeries(history, key);
    return [key, points.length > 1 ? points.at(-1).value - points.at(-2).value : null];
  }));
}

export function buildLiveRanking(database, now = new Date().toISOString()) {
  const ledgers = Array.isArray(database?.rankingLedgers) ? database.rankingLedgers : [];
  const notes = Array.isArray(database?.notes) ? database.notes : [];
  const rawEnvelopes = Array.isArray(database?.rawEnvelopes) ? database.rawEnvelopes : [];
  const completeness = new Map((database?.completenessLedgers ?? []).map((item) => [item.noteId, item]));
  const latestScopes = ledgers.flatMap((ledger) => {
    const snapshot = ledger?.snapshots?.at(-1) ?? null;
    return snapshot ? [{ ledger, snapshot, observedAt: snapshot.observedAt ?? ledger.updatedAt ?? null }] : [];
  }).sort((a, b) => timestamp(b.observedAt) - timestamp(a.observedAt));
  const snapshot = latestScopes[0]?.snapshot ?? null;
  const noteById = new Map(notes.map((note) => [note.noteId, note]));
  const admittedNoteIds = admittedWorkbenchNoteIds(database);
  const searchCardById = new Map();
  for (const envelope of [...rawEnvelopes]
    .filter((item) => item?.kind === "SEARCH_RESULTS" && Array.isArray(item?.payload?.cards))
    .sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt))) {
    for (const card of envelope.payload.cards) {
      if (!card?.noteId) continue;
      searchCardById.set(card.noteId, { ...card, observedAt: envelope.collectedAt });
    }
  }
  // Every keyword/scope owns an independent ranking ledger. A small new run
  // must not erase complete notes captured by other scopes. Merge the newest
  // snapshot from every ledger and let the newest occurrence win on duplicate
  // note ids.
  const occurrenceById = new Map();
  for (const scope of latestScopes) {
    const signals = new Map((scope.ledger?.latestSignals ?? []).map((signal) => [signal.noteId, signal]));
    for (const entry of scope.snapshot?.entries ?? []) {
      if (!entry?.noteId || occurrenceById.has(entry.noteId)) continue;
      occurrenceById.set(entry.noteId, { entry, ...scope, signal: signals.get(entry.noteId) ?? null });
    }
  }
  const rows = [...occurrenceById.values()].flatMap(({ entry, ledger: rankingLedger, snapshot: rankingSnapshot, signal }) => {
    const searchCard = searchCardById.get(entry.noteId) ?? null;
    const note = noteById.get(entry.noteId) ?? null;
    if (!note && !searchCard) return [];
    const ledger = completeness.get(entry.noteId) ?? null;
    const metricHistory = metricTimeline(database, entry.noteId);
    const metrics = currentMetrics(metricHistory);
    if (metrics.likes === null) metrics.likes = metric(note?.metrics?.likes ?? searchCard?.likes);
    for (const key of ["collects", "comments", "shares"]) {
      if (metrics[key] === null) metrics[key] = metric(note?.metrics?.[key] ?? searchCard?.[key]);
    }
    const mediaType = searchCard?.mediaType ?? (note?.assets?.some((asset) => asset?.type === "VIDEO") ? "VIDEO" : "UNKNOWN");
    const fullyAdmitted = admittedNoteIds.has(entry.noteId);
    return [{
      noteId: entry.noteId, rank: entry.rank, sourceRank: entry.rank, sourceScope: rankingSnapshot.scopeLabel ?? null,
      title: note?.title || searchCard?.title || "标题未采到", author: note?.author?.displayName || searchCard?.authorName || "作者未采到",
      sourceUrl: note?.provenance?.sourceUrls?.find((url) => /xiaohongshu\.com\/(explore|discovery|search_result)\//.test(url)) ?? note?.provenance?.sourceUrls?.[0] ?? searchCard?.sourceUrl ?? null,
      coverUrl: searchCard?.coverUrl ?? null,
      likes: metrics.likes, collects: metrics.collects, comments: metrics.comments, shares: metrics.shares,
      mediaType,
      trend: signal?.kind ?? "OBSERVED", rankDelta: metric(signal?.rankDelta), reason: reasonFor(signal, metrics),
      evidenceStatus: fullyAdmitted ? "ELIGIBLE" : mediaType === "VIDEO" ? "SEARCH_ONLY" : ledger?.overallStatus ?? "DISCOVERED",
      observedAt: metricHistory.at(-1)?.observedAt ?? searchCard?.observedAt ?? rankingSnapshot.observedAt,
      lastSeenAt: rankingSnapshot.observedAt ?? null,
      opportunityScore: opportunityScore(metrics),
      metricHistory,
      metricObservedAt: Object.fromEntries(metricKeys.map(key => [key, metricSeries(metricHistory, key).at(-1)?.observedAt ?? null])),
      metricDelta: metricChanges(metricHistory),
      rankHistory: (rankingLedger?.snapshots ?? []).map((item) => ({ observedAt: item.observedAt, rank: item.entries?.find((candidate) => candidate.noteId === entry.noteId)?.rank ?? null })).filter((item) => item.rank !== null),
    }];
  }).sort((a, b) => b.opportunityScore - a.opportunityScore
    || timestamp(b.observedAt) - timestamp(a.observedAt)
    || (a.sourceRank ?? Number.MAX_SAFE_INTEGER) - (b.sourceRank ?? Number.MAX_SAFE_INTEGER))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const scopeCount = latestScopes.length;
  return {
    status: snapshot ? "LIVE_EVIDENCE" : "NO_LIVE_EVIDENCE",
    generatedAt: now,
    scopeLabel: scopeCount > 1 ? `多关键词实时榜（${scopeCount} 个范围）` : snapshot?.scopeLabel ?? null,
    observedAt: latestScopes[0]?.observedAt ?? null,
    coverage: scopeCount > 1 ? `MERGED_${scopeCount}_SCOPES` : snapshot?.coverage ?? null,
    rows,
  };
}
