import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDiscoveredKeywords,
  applyKeywordResult,
  createRealKeywordResearchRun,
  discoverRelatedKeywords,
  nextResearchKeyword,
  normalizeResearchSettings,
  rebuildResearchInsights,
  sanitizeResearchError,
  sanitizeStoredResearchRun,
} from "./real-keyword-research.js";

test("creates a bounded, deduplicated real research queue", () => {
  const run = createRealKeywordResearchRun({
    seeds: "儿童画\n儿童画\n 幼儿绘画 ",
    settings: { maxDepth: 9, maxKeywords: 1, notesPerKeyword: 500, requestIntervalMs: 1 },
    now: "2026-09-25T04:00:00.000Z",
    runId: "research-contract",
  });
  assert.equal(run.queue.length, 1);
  assert.equal(run.queue[0].value, "儿童画");
  assert.equal(run.settings.maxDepth, 3);
  assert.equal(run.settings.notesPerKeyword, 12);
  assert.equal(run.settings.requestIntervalMs, 1000);
  assert.equal(nextResearchKeyword(run)?.value, "儿童画");
});

test("turns detached browser errors into a safe user-facing failure", () => {
  assert.deepEqual(
    sanitizeResearchError(new Error("Command failed with xsec_token=secret: Detached while handling command.")),
    { code: "BROWSER_SESSION_DETACHED", message: "浏览器连接在读取过程中中断，本轮没有入库" },
  );
});

test("sanitizes legacy persisted run errors before exposing history", () => {
  const raw = "Command failed: C:\\secret\\opencli.js xsec_token=private Detached while handling command.";
  const run = sanitizeStoredResearchRun({
    runId: "legacy-run",
    lastError: raw,
    queue: [{ value: "小红书", errors: [{ stage: "KEYWORD", error: raw }] }],
  });
  assert.equal(run.lastError, "浏览器连接在读取过程中中断，本轮没有入库");
  assert.deepEqual(run.queue[0].errors, [{
    stage: "KEYWORD",
    code: "BROWSER_SESSION_DETACHED",
    error: "浏览器连接在读取过程中中断，本轮没有入库",
  }]);
  assert.doesNotMatch(JSON.stringify(run), /private|secret|opencli\.js/);
});

test("discovers bounded related queries from real titles before generic intent patterns", () => {
  const candidates = discoverRelatedKeywords({
    parentKeyword: "儿童画",
    cards: [
      { title: "儿童画新手构图避坑", likes: 900 },
      { title: "幼儿园春天主题画｜三步就会", likes: 300 },
    ],
    existingKeywords: ["儿童画"],
    limit: 3,
  });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].source, "REAL_TITLE");
  assert.ok(candidates.some((item) => item.value.includes("儿童画")));
});

test("appends children within depth and total budgets and rolls result counters up", () => {
  const run = createRealKeywordResearchRun({ seeds: ["儿童画"], settings: normalizeResearchSettings({ maxDepth: 1, maxKeywords: 2, maxChildrenPerKeyword: 2 }) });
  const parent = run.queue[0];
  const added = appendDiscoveredKeywords(run, parent, [{ value: "儿童画 教程", source: "REAL_TITLE" }, { value: "儿童画 避坑" }]);
  assert.equal(added.length, 1);
  assert.equal(run.counters.totalKeywords, 2);
  applyKeywordResult(run, parent, {
    status: "SUCCEEDED", searchCardCount: 30, detailAttempted: 6, detailSucceeded: 5,
    fetchedCommentCount: 18, capturedCommentCount: 7, filteredOutCommentCount: 11,
    rejectedDetailReceipts: [{}], normalizedNoteIds: ["note-1"], errors: [],
  });
  assert.equal(run.counters.savedNotes, 5);
  assert.equal(run.counters.fetchedComments, 18);
  assert.equal(run.counters.retainedComments, 7);
  assert.equal(run.counters.rejectedNotes, 1);
});

test("links collected cards into keyword opportunities and repeat-account evidence", () => {
  const run = createRealKeywordResearchRun({ seeds: ["亲子画画"], settings: { maxKeywords: 3 } });
  const keyword = run.queue[0];
  applyKeywordResult(run, keyword, {
    status: "SUCCEEDED", searchCardCount: 2, detailAttempted: 2, detailSucceeded: 2,
    fetchedCommentCount: 8, capturedCommentCount: 3, filteredOutCommentCount: 5,
    normalizedNoteIds: ["n1", "n2"],
    searchCards: [
      { noteId: "n1", title: "4岁画画怎么开始", authorName: "阿圆", likes: 1200, ordinal: 1 },
      { noteId: "n2", title: "儿童画避坑", authorName: "阿圆", likes: 800, ordinal: 2 },
    ],
  });
  const insights = rebuildResearchInsights(run);
  assert.equal(insights.keywordOpportunities[0].keyword, "亲子画画");
  assert.equal(insights.competitorAccounts[0].authorName, "阿圆");
  assert.equal(insights.competitorAccounts[0].appearances, 2);
  assert.equal(insights.competitorAccounts[0].totalLikes, 2000);
});
