import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
const script = await readFile(new URL("./content-script.js", import.meta.url), "utf8");

for (const reason of ["HUMAN_REQUIRED", "CARD_OPEN_FAILED", "UNKNOWN_STRUCTURE", "PAGE_NOT_STABLE"]) {
  test(`diagnostic ${reason} releases the task instead of retrying the same lease forever`, async () => {
    const source = script.match(/const failCurrentTask = async \(snapshot, reason\) => \{([\s\S]*?)\n  \};/)?.[1];
    assert.ok(source, "missing task-bound failure handler");
    const requests = [];
    const context = {
      submitDiagnosticSnapshot: async () => {},
      send: async (request) => { requests.push(request); return { ok: true }; },
      showTask: () => {}, role: () => ({}), refreshRun: async () => {}, scheduleDrive: () => {},
    };
    await runInNewContext(`(async (snapshot, reason) => {${source}\n})`, context)({}, reason);
    assert.equal(requests[0].kind, "FAIL_BROWSER_TASK");
    assert.equal(requests[0].category, reason === "HUMAN_REQUIRED" ? "NEEDS_HUMAN" : "PERMANENT");
    assert.equal(requests[0].code, reason);
    assert.ok(!requests.some((request) => request.kind === "SET_BROWSER_AUTORUN"));
  });
}
test("all diagnostic failure branches use the task-bound handler", () => {
  assert.match(script, /await failCurrentTask\(initial, firstDecision.reason\)/);
  assert.match(script, /await failCurrentTask\(snapshot, decision.reason\)/);
  assert.doesNotMatch(script, /await retryAutoRun\("PAGE_NOT_STABLE"\)/);
});
