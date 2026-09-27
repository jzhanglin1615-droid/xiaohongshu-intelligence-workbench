// Presentation facts only: no estimates and no substitution of missing metrics.
export function rankingFacts(row) {
  const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const fields = [["likes", "点赞"], ["collects", "收藏"], ["shares", "转发"]];
  const missing = fields.filter(([key]) => !valid(row[key])).map(([, label]) => label);
  return {
    missing,
    complete: missing.length === 0,
    interactions: missing.length ? null : row.likes + row.collects + row.shares,
    collectLikeRatio: valid(row.likes) && row.likes > 0 && valid(row.collects) ? row.collects / row.likes : null,
    rankChange: Number.isFinite(Number(row.rankDelta)) ? Math.abs(Number(row.rankDelta)) : 0,
  };
}

// Evaluate the selected sample, not task completion or whole-platform coverage.
export function rankingCoverage(rows) {
  const missing = { likes: 0, collects: 0, shares: 0 };
  let complete = 0;
  for (const row of rows) {
    const facts = rankingFacts(row);
    if (facts.complete) complete++;
    for (const [key, label] of [["likes", "点赞"], ["collects", "收藏"], ["shares", "转发"]]) {
      if (facts.missing.includes(label)) missing[key]++;
    }
  }
  return { total: rows.length, complete, pending: rows.length - complete,
    completePercent: rows.length ? Math.round(complete / rows.length * 100) : null, missing };
}
