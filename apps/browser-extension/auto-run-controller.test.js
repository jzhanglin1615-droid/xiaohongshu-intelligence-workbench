import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./auto-run-controller.js", import.meta.url), "utf8");
const contentScriptSource = await readFile(new URL("./content-script.js", import.meta.url), "utf8");
const serviceWorkerSource = await readFile(new URL("./service-worker.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const controller = context.XhsAutoRunController;
const task = { targetUrl: "https://www.xiaohongshu.com/explore/note-1", expectedPageType: "NOTE_DETAIL" };
const visible = { pageType: "NOTE_DETAIL", status: "VISIBLE", noteId: "note-1", visibleText: "ready", visibleComments: [] };

test("auto run is inert until explicitly enabled", () => {
  assert.equal(controller.decide({ enabled: false, task, currentUrl: task.targetUrl, snapshot: visible }).action, "IDLE");
});

test("auto run leases when no task is active", () => {
  assert.equal(controller.decide({ enabled: true, task: null }).action, "LEASE");
});

test("stopped collection auto-starts unless the user explicitly paused it", () => {
  assert.equal(controller.shouldAutoStart({ enabled: false, status: "STOPPED" }), true);
  assert.equal(controller.shouldAutoStart({ enabled: false, status: "STOPPED", userPaused: true }), false);
  assert.equal(controller.shouldAutoStart({ enabled: false, status: "HALTED", userPaused: false }), true);
  assert.equal(controller.shouldAutoStart({ enabled: false, status: "RETRYING", userPaused: false }), true);
  assert.equal(controller.shouldAutoStart({ enabled: true, status: "RUNNING" }), false);
});

test("auto run navigates to an exact leased target", () => {
  const result = controller.decide({ enabled: true, task, currentUrl: "https://www.xiaohongshu.com/search_result?keyword=a", snapshot: visible });
  assert.equal(result.action, "NAVIGATE");
  assert.equal(result.targetUrl, task.targetUrl);
});

test("detail tasks open the matching real search card instead of navigating to a naked explore URL", () => {
  const clickTask = {
    ...task,
    context: {
      noteId: "note-1",
      navigationMode: "CLICK_SEARCH_CARD",
      parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=a",
    },
  };
  const snapshot = { pageType: "SEARCH", status: "VISIBLE", cards: [{ noteId: "note-1" }] };
  const result = controller.decide({ enabled: true, task: clickTask, currentUrl: clickTask.context.parentSearchUrl, snapshot });
  assert.equal(result.action, "OPEN_SEARCH_CARD");
  assert.equal(result.reason, "TARGET_CARD_VISIBLE");
  assert.equal(result.noteId, "note-1");
});

test("the next detail returns to its parent search when the previous note is still open", () => {
  const next = { ...task, context: { noteId: "note-1", navigationMode: "CLICK_SEARCH_CARD", parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=a" } };
  const result = controller.decide({ enabled: true, task: next, currentUrl: "https://www.xiaohongshu.com/explore/previous", snapshot: { ...visible, noteId: "previous" } });
  assert.equal(result.action, "NAVIGATE");
  assert.equal(result.targetUrl, next.context.parentSearchUrl);
});

test("an unexpected detail navigation preserves evidence and retries without disabling collection", () => {
  const clickTask = {
    ...task,
    context: {
      noteId: "note-1",
      navigationMode: "CLICK_SEARCH_CARD",
      parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=a",
    },
  };
  const result = controller.decide({ enabled: true, task: clickTask, currentUrl: "https://www.xiaohongshu.com/404?source=/404/sec", snapshot: { pageType: "UNKNOWN", status: "UNKNOWN_STRUCTURE" } });
  assert.equal(result.action, "SUBMIT_AND_RETRY");
  assert.equal(result.reason, "CARD_OPEN_FAILED");
});

test("extension panel reads canonical progress for keyword and ranking runs", () => {
  assert.match(contentScriptSource, /kind:\s*["']GET_COLLECTION_PROGRESS["']/);
  assert.doesNotMatch(contentScriptSource, /kind:\s*["']GET_KEYWORD_RUN["']/);
  assert.doesNotMatch(contentScriptSource, /kind:\s*["']GET_RANKING_RUN["']/);
  assert.match(serviceWorkerSource, /message\?\.kind === ["']GET_COLLECTION_PROGRESS["'][\s\S]*?request\(["']\/api\/collection\/progress["']/);
});

test("a missing card is skipped only after the stable parent search is proven", () => {
  const clickTask = {
    ...task,
    context: {
      noteId: "note-1",
      navigationMode: "CLICK_SEARCH_CARD",
      parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=a",
    },
  };
  const snapshot = { pageType: "SEARCH", status: "VISIBLE", cards: [{ noteId: "other" }] };
  assert.equal(controller.decide({ enabled: true, task: clickTask, currentUrl: clickTask.context.parentSearchUrl, snapshot, stable: false }).action, "WAIT");
  assert.equal(controller.decide({ enabled: true, task: clickTask, currentUrl: clickTask.context.parentSearchUrl, snapshot, stable: true }).action, "SKIP_AND_CONTINUE");
});

test("a search-route detail modal matches by note identity", () => {
  const clickTask = {
    ...task,
    context: {
      noteId: "note-1",
      navigationMode: "CLICK_SEARCH_CARD",
      parentSearchUrl: "https://www.xiaohongshu.com/search_result?keyword=a",
    },
  };
  assert.equal(controller.matchesTaskTarget(clickTask, clickTask.context.parentSearchUrl, visible), true);
});

test("URL comparison ignores fragments but preserves query parameters", () => {
  assert.equal(controller.canonicalUrl(`${task.targetUrl}#comments`), `${task.targetUrl}`);
  assert.notEqual(controller.canonicalUrl(`${task.targetUrl}?x=1`), controller.canonicalUrl(`${task.targetUrl}?x=2`));
});

test("redirected search route is accepted when the visible keyword matches", () => {
  const searchTask = {
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6&source=web_explore_feed",
    expectedPageType: "SEARCH",
    context: { keyword: "小红书" }
  };
  const snapshot = { pageType: "SEARCH", status: "VISIBLE", keyword: "小红书", cards: [{ noteId: "n1" }] };
  assert.equal(controller.decide({ enabled: true, task: searchTask, currentUrl: "https://www.xiaohongshu.com/search_result/", snapshot }).action, "WAIT");
});

test("redirected populated search route does not loop when Xiaohongshu consumes the query", () => {
  const searchTask = {
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6&source=web_explore_feed",
    expectedPageType: "SEARCH",
    context: { keyword: "小红书" }
  };
  const snapshot = { pageType: "SEARCH", status: "VISIBLE", keyword: "", cards: [{ noteId: "n1" }] };
  assert.equal(controller.decide({ enabled: true, task: searchTask, currentUrl: "https://www.xiaohongshu.com/search_result/", snapshot }).action, "WAIT");
});

test("redirected empty or mismatched searches still navigate to the leased target", () => {
  const searchTask = {
    targetUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%B0%8F%E7%BA%A2%E4%B9%A6&source=web_explore_feed",
    expectedPageType: "SEARCH",
    context: { keyword: "小红书" }
  };
  assert.equal(controller.decide({ enabled: true, task: searchTask, currentUrl: "https://www.xiaohongshu.com/search_result/", snapshot: { pageType: "SEARCH", status: "VISIBLE", keyword: "", cards: [] } }).action, "NAVIGATE");
  assert.equal(controller.decide({ enabled: true, task: searchTask, currentUrl: "https://www.xiaohongshu.com/search_result/", snapshot: { pageType: "SEARCH", status: "VISIBLE", keyword: "咖啡", cards: [{ noteId: "n2" }] } }).action, "NAVIGATE");
});

test("stable matching pages submit and unstable pages wait", () => {
  assert.equal(controller.decide({ enabled: true, task, currentUrl: task.targetUrl, snapshot: visible, stable: false }).action, "WAIT");
  assert.equal(controller.decide({ enabled: true, task, currentUrl: task.targetUrl, snapshot: visible, stable: true }).action, "SUBMIT");
});

test("human verification and unknown structures route to diagnostic failure handling", () => {
  assert.equal(controller.decide({ enabled: true, task, currentUrl: task.targetUrl, snapshot: { ...visible, status: "HUMAN_REQUIRED" } }).action, "SUBMIT_AND_RETRY");
  assert.equal(controller.decide({ enabled: true, task, currentUrl: task.targetUrl, snapshot: { ...visible, status: "UNKNOWN_STRUCTURE" } }).action, "SUBMIT_AND_RETRY");
});

test("stability requires consecutive equivalent semantic snapshots", () => {
  const tracker = new controller.StabilityTracker({ requiredMatches: 3, maxWaitMs: 10_000 });
  assert.equal(tracker.observe(visible, 1000).stable, false);
  assert.equal(tracker.observe(visible, 1500).stable, false);
  assert.equal(tracker.observe(visible, 2000).stable, true);
  assert.equal(tracker.observe({ ...visible, visibleText: "changed" }, 2500).consecutive, 1);
});

test("stability timeout records the failure and keeps automatic collection alive", () => {
  const tracker = new controller.StabilityTracker({ requiredMatches: 3, maxWaitMs: 1000 });
  tracker.observe(visible, 1000);
  const state = tracker.observe({ ...visible, visibleText: "still changing" }, 2001);
  assert.equal(state.timedOut, true);
  assert.equal(controller.decide({ enabled: true, task, currentUrl: task.targetUrl, snapshot: visible, timedOut: true }).action, "FAIL_AND_RETRY");
});
