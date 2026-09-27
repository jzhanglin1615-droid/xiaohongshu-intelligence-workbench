import { windowStats } from "./chart-data.js";
const number = (value) => Number.isFinite(value) ? value : null;
const time = (value) => Date.parse(value ?? "") || 0;
const latestObservation = (row) => Math.max(time(row.observedAt), time(row.lastSeenAt));

export function directionTerms(direction = "", preciseTerms = []) {
  const entered = [String(direction).trim(), ...preciseTerms]
    .flatMap((item) => String(item).split(/[，,、;；。\s]+/))
    .map((item) => item.normalize("NFKC").toLowerCase().trim())
    .filter((item) => item.length >= 2);
  const generic = new Set(["面向", "适合", "帮助", "新手", "用户", "人群", "关于", "内容", "方向", "方法", "如何", "怎么", "希望", "想要", "一个", "一种", "以及", "相关", "领域"]);
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const expanded = entered.flatMap((phrase) => phrase.length >= 5 && /[\p{Script=Han}]/u.test(phrase)
    ? [...segmenter.segment(phrase)].filter((part) => part.isWordLike).map((part) => part.segment)
      .filter((part) => part.length >= 2 && !generic.has(part))
    : []);
  return [...new Set([...entered, ...expanded])];
}

export function buildMarketTopics(rows = [], { windowHours = 24, direction = "", preciseTerms = [], now = new Date().toISOString() } = {}) {
  const cutoff = time(now) - windowHours * 60 * 60 * 1000;
  const terms = directionTerms(direction, preciseTerms);
  const recent = rows.filter((row) => latestObservation(row) >= cutoff && latestObservation(row) <= time(now));
  const inDirection = (row) => terms.some((term) => `${row.sourceScope ?? ""} ${row.title ?? ""}`.normalize("NFKC").toLowerCase().includes(term));
  const assemble = (source, fixedLabel = null) => {
    const groups = new Map();
    for (const row of source) {
      const label = fixedLabel ?? (String(row.sourceScope ?? "未分类搜索").replace(/^搜索结果[：:]/, "").trim() || "未分类搜索");
      groups.set(label, [...(groups.get(label) ?? []), row]);
    }
    return [...groups].map(([label, items]) => {
      const ranked = items.map((row) => {
        const likes = number(row.likes) ?? 0;
        const collects = number(row.collects) ?? 0;
        const shares = number(row.shares) ?? 0;
        const delta = Object.fromEntries(['likes','collects','shares'].map(key => [key,windowStats(row.metricHistory ?? [], key, windowHours, now).delta]));
        const recentGrowth = Math.max(0, number(delta.likes) ?? 0) + Math.max(0, number(delta.collects) ?? 0) * 3 + Math.max(0, number(delta.shares) ?? 0) * 4;
        const engagement = likes + collects * 3 + shares * 4;
        const trendBoost = row.trend === "RISING" ? 1.35 : row.trend === "NEW_ENTRY" ? 1.2 : row.trend === "FALLING" ? 0.7 : 1;
        return { ...row, marketScore: Math.round((recentGrowth * 4 + engagement) * trendBoost), recentGrowth };
      }).sort((a, b) => b.marketScore - a.marketScore || latestObservation(b) - latestObservation(a));
      const growth = ranked.reduce((sum, row) => sum + row.recentGrowth, 0);
      const falling = ranked.filter((row) => row.trend === "FALLING").length;
      const rising = ranked.filter((row) => row.trend === "RISING" || row.recentGrowth > 0).length;
      const lastUpdatedAt = ranked.flatMap((row) => [row.observedAt, row.lastSeenAt]).filter((value) => time(value) > 0).sort((a, b) => time(b) - time(a))[0] ?? null;
      return { label, rows: ranked, count: ranked.length, score: ranked.reduce((sum, row) => sum + row.marketScore, 0), growth, trend: rising > falling ? "UP" : falling > rising ? "DOWN" : "FLAT", coverage: ranked.filter((row) => row.likes !== null && row.collects !== null && row.shares !== null).length, lastUpdatedAt };
    }).sort((a, b) => b.score - a.score || b.growth - a.growth);
  };
  return { all: assemble(recent), direction: terms.length ? assemble(recent.filter(inDirection), String(direction).trim()) : [], sampleCount: recent.length, directionTerms: terms };
}
