import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({ URL });
vm.runInContext(await readFile(new URL("./extractor.js", import.meta.url), "utf8"), context);
const metric = context.XhsDetailMetric;
const node = (textContent, comment = false) => ({ textContent, closest: () => comment ? {} : null });
const scope = (nodes) => ({ querySelector: () => nodes[0] || null, querySelectorAll: () => nodes });

test("post metrics skip comment likes even when comments precede the post bar", () => {
  assert.equal(metric(scope([node("赞", true), node("10")]), [".like-wrapper .count"], ["赞"]), 10);
});
test("comment-only likes are unknown, not a zero post like count", () => {
  assert.equal(metric(scope([node("赞", true)]), [".like-wrapper .count"], ["赞"]), null);
});
test("preserves genuine zero and missing shares as different states", () => {
  assert.equal(metric(scope([node("赞")]), [".like-wrapper .count"], ["赞"]), 0);
  assert.equal(metric(scope([]), [".share-wrapper .count"], ["分享"]), null);
});
