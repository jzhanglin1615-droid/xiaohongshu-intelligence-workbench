import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const body = app.match(/el\("collection-use-direction"\)\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\}\);/)[1];
function fill(value, marketState) {
  const fields = { 'seed-keywords': { value, focus() {} }, 'collection-direction-feedback': {} };
  runInNewContext(`(() => {${body}})()`, { state: { marketState }, el: id => fields[id], saveDraft() { throw Error('storage disabled'); } });
  return fields;
}
test('saved direction fills empty draft without starting collection', () => {
  assert.equal(fill('', {direction:'收纳', preciseTerms:['收纳','衣柜']})['seed-keywords'].value, '收纳\n衣柜');
  assert.doesNotMatch(body, /await api|fetch\(/);
});
test('existing inputs are not overwritten', () => {
  assert.equal(fill('当前输入', {direction:'收纳'})['seed-keywords'].value, '当前输入');
});
test('missing direction has an actionable explanation', () => {
  assert.match(fill('', null)['collection-direction-feedback'].textContent, /临时关键词/);
});
test('collection and ranking share one control card and secondary insights are folded', () => {
  assert.equal((html.match(/id="collection-live-card"/g) ?? []).length, 1);
  assert.match(app, /view === "collection" \? el\("collection-control-host"\) : el\("market-control-host"\)/);
  assert.match(html, /<details class="collection-diagnostics panel">/);
  assert.match(app, /const savedCount = job \? Number\(progress\?\.admitted \?\? counters.admittedCards \?\? counters.ingestedCandidates \?\? 0\) : 0/);
});
