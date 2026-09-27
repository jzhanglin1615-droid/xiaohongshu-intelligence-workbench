import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchWorkspace } from './research-workspace.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const now = '2026-09-26T12:00:00Z';
const rows = [
 { noteId:'a', title:'收纳 A', likes:100, collects:2, shares:null, observedAt:now },
 { noteId:'b', title:'收纳 B', likes:20, collects:50, shares:10, observedAt:now },
 { noteId:'c', title:'旅行', likes:900, collects:900, shares:900, observedAt:now },
 { noteId:'d', title:'收纳旧帖', likes:200, collects:20, shares:2, observedAt:'2026-09-24T12:00:00Z' },
];
const build = (options = {}) => buildResearchWorkspace(rows, {direction:'收纳', now, ...options});
test('direction and window exclude unrelated and old samples', () => {
 assert.equal(build().coverage.total,2);
 assert.equal(build({windowHours:72}).coverage.total,3);
 assert.equal(build({scope:'all'}).coverage.total,3);
});
test('purpose changes actual selection, not just label', () => {
 assert.equal(build().examples[0].noteId,'a');
 assert.equal(build({purpose:'value'}).examples[0].noteId,'b');
 assert.deepEqual(build({purpose:'share'}).examples.map(r=>r.noteId),['b']);
});
test('missing is never replaced with zero or marked complete', () => {
 assert.equal(build().coverage.complete,1);
 assert.equal(build({purpose:'share'}).missing,1);
 assert.deepEqual(build().examples[0].facts.missing,['转发']);
});
test('unset or unmatched direction never falls back to all-site', () => {
 assert.equal(build({direction:''}).coverage.total,0);
 assert.equal(build({direction:'烹饪'}).coverage.total,0);
});
test('genuine zero is comparable and samples are deduplicated', () => {
 const row={noteId:'z',title:'收纳',likes:0,collects:0,shares:0,observedAt:now};
 const result=buildResearchWorkspace([row,row],{direction:'收纳',now});
 assert.equal(result.comparable,1); assert.equal(result.coverage.complete,1);
});
test('review saves locally and reports failure without losing input', () => {
 const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 const body=app.match(/el\("research-review"\)\.addEventListener\("input", \(\) => \{([\s\S]*?)\n\}\);/)[1];
 const fields={'research-review':{value:'我的复盘',dataset:{key:'direction:topic'}},'research-review-status':{}};
 let saved;
 runInNewContext(body,{el:id=>fields[id],localStorage:{setItem:(key,value)=>{saved=[key,value];}}});
 assert.deepEqual(saved,['direction:topic','我的复盘']);
 runInNewContext(body,{el:id=>fields[id],localStorage:{setItem:()=>{throw Error('quota');}}});
 assert.match(fields['research-review-status'].textContent,/保存失败/);
 assert.equal(fields['research-review'].value,'我的复盘');
 assert.doesNotMatch(body,/fetch|api\(/);
});
