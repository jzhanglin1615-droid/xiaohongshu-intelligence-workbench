import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { rankingFacts } from "./ranking-evidence.js";
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const submitBody = app.match(/el\("market-direction-form"\)\.addEventListener\("submit", async \(event\) => \{([\s\S]*?)\n\}\);/)[1];
function fixture(api) {
  const fields = {
    "market-direction": { value: "收纳", setAttribute() {}, focus() { this.focused = true; } },
    "market-terms": { value: "衣柜" }, "market-direction-save": {}, "seed-keywords": {},
  };
  const state = { marketDraftDirty: true, marketDraftRevision: 1 };
  const messages = [];
  const submit = runInNewContext(`(async (event) => {${submitBody}\n})`, {
    state, el: id => fields[id], api, directionFeedback: message => messages.push(message),
    renderMarket() {}, renderFavorites() {}, saveDraft() {}, toast() {}, directionTerms: d => [d],
  });
  return { fields, state, messages, submit: () => submit({ preventDefault() {} }) };
}
test("empty direction focuses input without issuing a request", async () => {
  const f = fixture(() => { throw new Error("must not request"); });
  f.fields["market-direction"].value = " ";
  await f.submit();
  assert.equal(f.fields["market-direction"].focused, true);
  assert.match(f.messages.at(-1), /请填写/);
});
test("failed save retains draft and restores the button", async () => {
  const f = fixture(async () => { throw new Error("offline"); });
  await f.submit();
  assert.equal(f.fields["market-direction"].value, "收纳");
  assert.equal(f.state.marketDraftDirty, true);
  assert.equal(f.fields["market-direction-save"].disabled, false);
  assert.match(f.messages.at(-1), /输入已保留/);
});
test("double submit is suppressed and edits during save remain unsaved", async () => {
  let resolve; let calls = 0;
  const f = fixture(() => { calls++; return new Promise(r => { resolve = r; }); });
  const first = f.submit();
  await f.submit();
  assert.equal(calls, 1);
  assert.equal(f.fields["market-direction-save"].disabled, true);
  f.state.marketDraftRevision++;
  f.fields["market-direction"].value = "厨房";
  resolve({ direction: "收纳" });
  await first;
  assert.equal(f.state.marketDraftDirty, true);
  assert.equal(f.fields["market-direction"].value, "厨房");
  assert.match(f.messages.at(-1), /新修改仍未保存/);
});
test("pending candidates expand beyond ten, preserve open state, and escape titles", () => {
  const source = app.slice(app.indexOf("function pendingCandidates("), app.indexOf("function metricDeltaLabel("));
  const render = runInNewContext(`${source}; pendingCandidates`, {
    rankingFacts, hasThreeMetrics: row => rankingFacts(row).complete,
    esc: value => String(value).replaceAll("<", "&lt;"),
  });
  const rows = Array.from({ length: 23 }, (_, i) => ({ noteId: String(i), title: `<title${i}>`, likes: 1 }));
  assert.equal((render(rows).match(/class="pending-candidate"/g) ?? []).length, 10);
  const expanded = render(rows, { open: true, limit: 20 });
  assert.equal((expanded.match(/class="pending-candidate"/g) ?? []).length, 20);
  assert.match(expanded, /open>/);
  assert.match(expanded, /剩余 3 条/);
  assert.match(expanded, /data-pending-reset/);
  assert.doesNotMatch(expanded, /<title/);
});
