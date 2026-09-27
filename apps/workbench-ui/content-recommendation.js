const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

function relativeRank(value, values) {
  if (value === null || values.length < 2) return value === null ? 0 : 0.5;
  const below = values.filter((item) => item < value).length;
  const equal = values.filter((item) => item === value).length;
  return (below + Math.max(0, equal - 1) / 2) / (values.length - 1);
}

function momentumValue(row) {
  if (row.trend === "NEW_ENTRY") return 0.9;
  if (row.trend === "REENTERED") return 0.8;
  if (row.trend === "RISING") return Math.min(1, 0.65 + Math.max(0, number(row.rankDelta) ?? 0) * 0.05);
  if (row.trend === "UNCHANGED") return 0.45;
  if (row.trend === "FALLING") return 0.1;
  return 0.35;
}

function evidenceFor(row, nowMs) {
  const metrics = [row.likes, row.collects, row.comments, row.shares].filter((value) => number(value) !== null).length;
  const observedMs = Date.parse(row.observedAt ?? "");
  const ageHours = Number.isFinite(observedMs) ? Math.max(0, (nowMs - observedMs) / 3_600_000) : Infinity;
  const fresh = ageHours <= 24;
  const traceable = typeof row.sourceUrl === "string" && /^https:\/\//.test(row.sourceUrl);
  const completeStatus = ["COMPLETE", "ELIGIBLE"].includes(row.evidenceStatus);
  const eligible = fresh && traceable && metrics >= 3;
  const strength = (metrics / 4) * 0.5 + (fresh ? 0.25 : 0) + (traceable ? 0.15 : 0) + (completeStatus ? 0.1 : 0);
  return { eligible, metrics, ageHours, fresh, traceable, completeStatus, strength };
}

function metricReason(label, value, percentile) {
  if (value === null) return null;
  const tier = percentile >= 0.8 ? "本批前 20%" : percentile >= 0.6 ? "本批较高" : "已有真实数据";
  return `${label} ${new Intl.NumberFormat("zh-CN").format(value)}（${tier}）`;
}

export function buildContentRecommendation(ranking, options = {}) {
  const rows = Array.isArray(ranking?.rows) ? ranking.rows : [];
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const direction = options.direction ?? { status: "UNSET" };
  const values = Object.fromEntries(["likes", "collects", "comments", "shares"].map((key) => [key, rows.map((row) => number(row[key])).filter((value) => value !== null)]));
  const candidates = rows.map((row) => {
    const metrics = Object.fromEntries(["likes", "collects", "comments", "shares"].map((key) => [key, { value: number(row[key]), percentile: relativeRank(number(row[key]), values[key]) }]));
    const evidence = evidenceFor(row, Number.isFinite(nowMs) ? nowMs : Date.now());
    const score = metrics.comments.percentile * 0.3
      + metrics.collects.percentile * 0.25
      + metrics.shares.percentile * 0.15
      + momentumValue(row) * 0.15
      + metrics.likes.percentile * 0.1
      + evidence.strength * 0.05;
    return { row, metrics, evidence, score };
  }).filter((item) => item.evidence.eligible).sort((a, b) => b.score - a.score || a.row.rank - b.row.rank);

  if (!candidates.length) {
    return {
      status: rows.length ? "INSUFFICIENT_EVIDENCE" : "NO_LIVE_EVIDENCE",
      label: "暂不推荐",
      title: rows.length ? "数据还不足以支持今天的首选" : "等待第一批真实爆款",
      guidance: rows.length ? "至少需要新鲜榜单、可追溯原文和 3 项真实互动数据。" : "采集到真实榜单后，这里会自动给出首选内容。",
      updatedAt: ranking?.observedAt ?? null,
      confidence: "不足",
      accountFitStatus: direction.status === "CONFIRMED" ? "可评估" : "方向待设置",
      topPick: null,
      alternatives: [],
    };
  }

  const top = candidates[0];
  const evidenceReasons = [
    metricReason("评论", top.metrics.comments.value, top.metrics.comments.percentile),
    metricReason("收藏", top.metrics.collects.value, top.metrics.collects.percentile),
    metricReason("转发", top.metrics.shares.value, top.metrics.shares.percentile),
    ["RISING", "NEW_ENTRY", "REENTERED"].includes(top.row.trend) ? top.row.reason : null,
  ].filter(Boolean).slice(0, 3);
  const confidence = top.evidence.completeStatus && top.evidence.metrics === 4 ? "高" : top.evidence.metrics >= 3 ? "中" : "低";
  const directionConfirmed = direction.status === "CONFIRMED" && direction.userConfirmed === true;
  const topic = top.row.title.replace(/[｜|丨].*$/, "").trim();
  return {
    status: "READY",
    label: directionConfirmed ? "最适合你的首选" : "当前平台首选",
    title: topic,
    guidance: directionConfirmed
      ? "优先围绕评论区最想解决的问题，用你的真实经历、步骤或对比结果来做。"
      : "先围绕评论区最想解决的问题做；账号方向尚未设置，因此这代表平台机会，不冒充个人适配结论。",
    updatedAt: top.row.observedAt ?? ranking?.observedAt ?? null,
    confidence,
    accountFitStatus: directionConfirmed ? "已结合账号方向" : "方向待设置",
    topPick: { ...top.row, score: top.score, evidenceReasons },
    alternatives: candidates.slice(1, 4).map((item) => ({ ...item.row, score: item.score })),
  };
}
