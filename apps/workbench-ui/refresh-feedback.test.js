import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describeRefreshOutcome } from "./refresh-feedback.js";

test("an unchanged refresh never repeats counts from an old collector run", () => {
  const result = describeRefreshOutcome({ receipt: { status: "SUCCEEDED" }, beforeSignature: "same", afterSignature: "same", afterCount: 18 });
  assert.equal(result.tone, "info");
  assert.match(result.message, /暂无数据变化/);
  assert.doesNotMatch(result.message, /详情补证 5/);
});

test("a changed refresh reports the current candidate count", () => {
  const result = describeRefreshOutcome({ receipt: { status: "SUCCEEDED" }, beforeSignature: "before", afterSignature: "after", afterCount: 19 });
  assert.equal(result.tone, "success");
  assert.match(result.message, /当前 19 条候选/);
  assert.match(result.message, /榜单或观测时间有更新/);
});

test("a browser task is described as dispatched rather than completed", () => {
  const result = describeRefreshOutcome({ receipt: { status: "DISPATCHED", capture: { kind: "BROWSER_TASK" } }, beforeSignature: "before", afterSignature: "before", afterCount: 18 });
  assert.equal(result.tone, "info");
  assert.match(result.message, /任务已发出/);
});

test("failed, missing and dispatched receipts cannot report completion", () => {
  for (const receipt of [null, { status: "FAILED" }, { status: "DISPATCHED" }]) {
    const result = describeRefreshOutcome({ receipt, beforeSignature: "old", afterSignature: "new" });
    assert.doesNotMatch(result.message, /^更新完成/);
  }
});

test("ranking signature notices a newer in-rank observation even when metrics do not change", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const body = app.match(/function rankingDataSignature\(ranking\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body);
  const signature = runInNewContext(`((ranking) => {${body}\n})`);
  const row = { noteId: "n1", likes: 10, collects: 2, shares: 1, observedAt: "2026-09-25T09:00:00Z", lastSeenAt: "2026-09-25T10:00:00Z" };
  assert.notEqual(signature({ rows: [row] }), signature({ rows: [{ ...row, lastSeenAt: "2026-09-25T11:00:00Z" }] }));
});
