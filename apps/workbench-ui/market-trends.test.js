import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketTopics, directionTerms } from "./market-trends.js";

const now = "2026-09-25T12:00:00.000Z";
const rows = [
  { noteId: "a", sourceScope: "搜索结果：AI绘画", title: "AI绘画教程", observedAt: "2026-09-25T11:00:00.000Z", likes: 100, collects: 30, shares: 10, metricDelta: { likes: 50, collects: 20, shares: 5 }, trend: "RISING" },
  { noteId: "b", sourceScope: "搜索结果：家常菜", title: "家常菜做法", observedAt: "2026-09-25T10:00:00.000Z", likes: 1000, collects: null, shares: null, metricDelta: {}, trend: "OBSERVED" },
  { noteId: "c", sourceScope: "搜索结果：AI绘画", title: "旧教程", observedAt: "2026-09-23T10:00:00.000Z", likes: 10000, collects: 1000, shares: 100, trend: "FALLING" },
];

test("user direction and precise terms are normalized without importing a default niche", () => {
  assert.deepEqual(directionTerms(" AI绘画 教程 ", ["AI绘画", "素材、工具"]), ["ai绘画", "教程", "素材", "工具"]);
  assert.deepEqual(directionTerms(""), []);
  assert.ok(directionTerms("面向新手的家庭收纳方法").includes("收纳"));
});

test("24-hour market view favors rising interactions and does not invent missing metrics", () => {
  const evidencedRows = rows.map(row => row.noteId === 'a' ? {...row,metricHistory:[
    {observedAt:'2026-09-25T09:00:00Z',likes:50,collects:10,shares:5},
    {observedAt:'2026-09-25T11:00:00Z',likes:100,collects:30,shares:10}
  ]} : row);
  const market = buildMarketTopics(evidencedRows, { now, direction: "AI绘画", windowHours: 24 });
  assert.equal(market.sampleCount, 2);
  assert.equal(market.all[0].label, "AI绘画");
  assert.equal(market.direction.length, 1);
  assert.equal(market.direction[0].label, "AI绘画");
  assert.equal(market.direction[0].rows[0].noteId, "a");
  assert.equal(market.all.find((topic) => topic.label === "家常菜").coverage, 0);
});

test("changing direction switches the focused board while all-site remains sampled", () => {
  const market = buildMarketTopics(rows, { now, direction: "家常菜", windowHours: 72 });
  assert.equal(market.sampleCount, 3);
  assert.deepEqual(market.direction.map((topic) => topic.label), ["家常菜"]);
  assert.equal(market.all.length, 2);
});

test("the selected direction is a single replaceable entry even when several searches match", () => {
  const market = buildMarketTopics([
    { ...rows[0], sourceScope: "搜索结果：AI绘画" },
    { ...rows[0], noteId: "a2", sourceScope: "搜索结果：AI教程" },
  ], { now, direction: "AI", windowHours: 24 });
  assert.equal(market.direction.length, 1);
  assert.equal(market.direction[0].label, "AI");
  assert.equal(market.direction[0].rows.length, 2);
});

test("each topic carries the latest observation time of its own posts", () => {
  const market = buildMarketTopics([...rows, { ...rows[0], noteId: "a2", observedAt: "2026-09-25T11:30:00.000Z" }], { now, windowHours: 24 });
  assert.equal(market.all.find((topic) => topic.label === "AI绘画").lastUpdatedAt, "2026-09-25T11:30:00.000Z");
  assert.equal(market.all.find((topic) => topic.label === "家常菜").lastUpdatedAt, "2026-09-25T10:00:00.000Z");
});

test("a newly rechecked ranking remains in the 24-hour view even if detailed metrics are older", () => {
  const market = buildMarketTopics([{ ...rows[2], lastSeenAt: "2026-09-25T11:45:00.000Z" }], { now, windowHours: 24 });
  assert.equal(market.sampleCount, 1);
  assert.equal(market.all[0].lastUpdatedAt, "2026-09-25T11:45:00.000Z");
});
