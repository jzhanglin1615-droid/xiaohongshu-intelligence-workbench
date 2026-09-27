const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const isRising = (row) => ["RISING", "NEW_ENTRY", "REENTERED"].includes(row.trend);

function normalized(value, maximum) {
  return value === null || maximum <= 0 ? 0 : Math.log1p(value) / Math.log1p(maximum);
}

export function buildAutoTopics(ranking, { limit = 12 } = {}) {
  const rows = Array.isArray(ranking?.rows) ? ranking.rows : [];
  if (!rows.length) return [];
  const maxima = {
    likes: Math.max(0, ...rows.map((row) => number(row.likes) ?? 0)),
    collects: Math.max(0, ...rows.map((row) => number(row.collects) ?? 0)),
    shares: Math.max(0, ...rows.map((row) => number(row.shares) ?? 0)),
  };
  return rows.map((row) => {
    const metrics = { likes: number(row.likes), collects: number(row.collects), shares: number(row.shares) };
    const coverage = Object.values(metrics).filter((value) => value !== null).length;
    const delta = row.metricDelta ?? {};
    const growth = [delta.likes, delta.collects, delta.shares].reduce((sum, item) => sum + Math.max(0, number(item) ?? 0), 0);
    const strength = normalized(metrics.likes, maxima.likes) * 0.32
      + normalized(metrics.collects, maxima.collects) * 0.36
      + normalized(metrics.shares, maxima.shares) * 0.22;
    const momentum = (isRising(row) ? 0.07 : 0) + Math.min(0.08, Math.log1p(growth) / 80);
    const completeness = coverage / 3 * 0.08;
    const rankSignal = Math.max(0, 1 - (Number(row.rank ?? rows.length) - 1) / Math.max(rows.length, 1)) * 0.05;
    const score = Math.round(Math.min(1, strength + momentum + completeness + rankSignal) * 100);
    const readiness = coverage === 3 && (isRising(row) || growth > 0) ? "DO_NOW" : coverage >= 2 ? "VERIFY" : "WATCH";
    const strongest = [["收藏", metrics.collects], ["转发", metrics.shares], ["点赞", metrics.likes]].filter(([, value]) => value !== null).sort((a, b) => b[1] - a[1])[0];
    const reason = coverage < 3
      ? `${strongest?.[0] ?? "互动"}已有信号，仍有 ${3 - coverage} 项核心指标待补详情`
      : growth > 0
        ? `同帖核心互动新增 ${growth}，${strongest?.[0] ?? "互动"}信号最强`
        : `${strongest?.[0] ?? "互动"}信号最强，结合当前排名优先验证`;
    return { row, score, readiness, coverage, reason };
  }).sort((a, b) => b.score - a.score || a.row.rank - b.row.rank).slice(0, limit).map((item, index) => ({
    ...item,
    label: index === 0 ? "自动首选" : item.readiness === "DO_NOW" ? "值得马上做" : item.readiness === "VERIFY" ? "先验证" : "继续观察",
  }));
}
