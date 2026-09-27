import test from "node:test";
import assert from "node:assert/strict";
import { rankingFacts, rankingCoverage } from "./ranking-evidence.js";

test("coverage counts each missing metric without confusing empty samples and zero", () => {
  assert.equal(rankingCoverage([]).completePercent, null);
  assert.deepEqual(rankingCoverage([
    { likes: 0, collects: 0, shares: 0 },
    { likes: 10, collects: null, shares: undefined },
    { likes: -1, collects: 2, shares: 1 },
  ]), { total: 3, complete: 1, pending: 2, completePercent: 33, missing: { likes: 1, collects: 1, shares: 1 } });
});

test("missing and invalid metrics never become zero or a complete ranking", () => {
  for (const value of [null, undefined, NaN, Infinity, -1, "12"]) {
    const facts = rankingFacts({ likes: 10, collects: value, shares: 2 });
    assert.equal(facts.complete, false);
    assert.equal(facts.interactions, null);
    assert.deepEqual(facts.missing, ["收藏"]);
  }
});
test("observed zeros are valid but a zero denominator has no ratio", () => {
  assert.deepEqual(rankingFacts({ likes: 0, collects: 0, shares: 0 }), {
    complete: true, missing: [], interactions: 0, collectLikeRatio: null, rankChange: 0,
  });
});
test("ratio and falling rank magnitude preserve numerical meaning", () => {
  const facts = rankingFacts({ likes: 100, collects: 25, shares: 5, rankDelta: -3 });
  assert.equal(facts.interactions, 130);
  assert.equal(facts.collectLikeRatio, 0.25);
  assert.equal(facts.rankChange, 3);
});
