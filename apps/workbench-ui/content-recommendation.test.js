import assert from "node:assert/strict";
import test from "node:test";
import { buildContentRecommendation } from "./content-recommendation.js";

const ranking = {
  observedAt: "2026-09-25T10:00:00.000Z",
  rows: [
    { noteId: "n1", rank: 1, title: "点赞很多", trend: "UNCHANGED", reason: "持续在榜", likes: 10000, collects: 20, comments: 3, shares: 2, observedAt: "2026-09-25T10:00:00.000Z", sourceUrl: "https://www.xiaohongshu.com/explore/n1", evidenceStatus: "COMPLETE" },
    { noteId: "n2", rank: 4, title: "用户问题集中", trend: "RISING", rankDelta: 5, reason: "上升 5 位", likes: 4000, collects: 900, comments: 600, shares: 300, observedAt: "2026-09-25T10:00:00.000Z", sourceUrl: "https://www.xiaohongshu.com/explore/n2", evidenceStatus: "COMPLETE" },
  ],
};

test("links engagement, momentum and evidence into one defensible top pick", () => {
  const result = buildContentRecommendation(ranking, { now: "2026-09-25T11:00:00.000Z", direction: { status: "UNSET" } });
  assert.equal(result.status, "READY");
  assert.equal(result.topPick.noteId, "n2");
  assert.equal(result.label, "当前平台首选");
  assert.equal(result.accountFitStatus, "方向待设置");
  assert.match(result.topPick.evidenceReasons.join(" "), /评论 600/);
  assert.match(result.topPick.evidenceReasons.join(" "), /收藏 900/);
});

test("does not promote stale, untraceable or thin rows", () => {
  const result = buildContentRecommendation({ rows: [{ noteId: "thin", rank: 1, title: "薄证据", likes: 1, collects: null, comments: null, shares: null, observedAt: "2026-09-20T00:00:00.000Z", sourceUrl: null }] }, { now: "2026-09-25T11:00:00.000Z" });
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.topPick, null);
});

test("only claims personal fit for a user-confirmed direction", () => {
  const result = buildContentRecommendation(ranking, { now: "2026-09-25T11:00:00.000Z", direction: { status: "CONFIRMED", userConfirmed: true } });
  assert.equal(result.label, "最适合你的首选");
  assert.equal(result.accountFitStatus, "已结合账号方向");
});
