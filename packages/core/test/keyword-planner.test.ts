import assert from "node:assert/strict";
import test from "node:test";
import type { KeywordPolicy } from "../../contracts/src/index.ts";
import { WorkbenchError } from "../src/errors.ts";
import { buildKeywordPlan } from "../src/keyword-planner.ts";

const policy: KeywordPolicy = {
  maxDepth: 2,
  maxKeywords: 10,
  maxChildrenPerKeyword: 2,
  noteDetailsPerKeyword: 2,
  maxEstimatedNoteDetails: 8,
  excludedTerms: ["招聘"],
};

test("keyword planner builds a normalized parent-child graph within every budget", () => {
  const plan = buildKeywordPlan({
    planId: "keyword-plan-local",
    taskId: "keyword-task-local",
    seedKeywords: [" AI工具 ", "ai工具"],
    policy,
    expansions: [
      { parent: "AI工具", children: ["AI写作", "AI 绘图", "招聘AI", "第四个词", "ai写作"] },
      { parent: "AI写作", children: ["AI工具教程", "AI 绘图"] },
      { parent: "AI 绘图", children: ["深层词"] },
      { parent: "AI工具教程", children: ["超过深度"] },
    ],
    createdAt: "2026-09-24T03:00:00.000Z",
  });

  assert.deepEqual(plan.nodes.map((node) => node.normalized), ["ai工具", "ai写作", "ai 绘图", "ai工具教程"]);
  assert.equal(plan.nodes.length, 4);
  assert.equal(plan.estimatedNoteDetails, 8);
  assert.ok(plan.edges.length >= 3);
  assert.equal(plan.truncation.hitNoteBudget, true);
  assert.equal(plan.truncation.prunedByExclusion, 1);
  assert.equal(plan.truncation.prunedByChildLimit, 1);
  assert.equal(plan.truncation.prunedByDepth, 1);
});

test("keyword planner stops before the keyword count can exceed the user budget", () => {
  const plan = buildKeywordPlan({
    planId: "keyword-count-budget",
    taskId: "keyword-count-task",
    seedKeywords: ["种子"],
    policy: { ...policy, maxKeywords: 2, maxEstimatedNoteDetails: 20 },
    expansions: [{ parent: "种子", children: ["词一", "词二", "词三"] }],
    createdAt: "2026-09-24T03:00:00.000Z",
  });
  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.truncation.hitKeywordLimit, true);
});

test("keyword planner rejects a seed that conflicts with an exclusion rule", () => {
  assert.throws(
    () => buildKeywordPlan({
      planId: "keyword-excluded-seed",
      taskId: "keyword-excluded-task",
      seedKeywords: ["AI招聘"],
      policy,
      expansions: [],
      createdAt: "2026-09-24T03:00:00.000Z",
    }),
    (error: unknown) => error instanceof WorkbenchError && error.code === "KEYWORD_SEED_EXCLUDED",
  );
});

test("keyword identities stay stable when suggestion order changes", () => {
  const base = {
    planId: "keyword-stable",
    taskId: "keyword-stable-task",
    seedKeywords: ["AI工具"],
    policy: { ...policy, maxEstimatedNoteDetails: 20 },
    createdAt: "2026-09-24T03:00:00.000Z",
  };
  const first = buildKeywordPlan({ ...base, expansions: [{ parent: "AI工具", children: ["AI写作", "AI绘图"] }] });
  const second = buildKeywordPlan({ ...base, expansions: [{ parent: "AI工具", children: ["AI绘图", "AI写作"] }] });
  assert.deepEqual(
    Object.fromEntries(first.nodes.map((node) => [node.normalized, node.keywordId])),
    Object.fromEntries(second.nodes.map((node) => [node.normalized, node.keywordId])),
  );
});
