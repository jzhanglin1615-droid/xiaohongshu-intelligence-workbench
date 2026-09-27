import test from "node:test";
import assert from "node:assert/strict";
import { buildAutoTopics } from "./topic-intelligence.js";

test("auto topics prioritize complete, growing save and share evidence", () => {
  const topics = buildAutoTopics({ rows: [
    { noteId: "a", rank: 1, likes: 1000, collects: null, shares: null, trend: "STABLE", metricDelta: { likes: 0 } },
    { noteId: "b", rank: 3, likes: 800, collects: 280, shares: 90, trend: "RISING", metricDelta: { likes: 60, collects: 20, shares: 8 } },
  ] });
  assert.equal(topics[0].row.noteId, "b");
  assert.equal(topics[0].label, "自动首选");
  assert.equal(topics[0].readiness, "DO_NOW");
  assert.match(topics[0].reason, /同帖核心互动新增/);
});
