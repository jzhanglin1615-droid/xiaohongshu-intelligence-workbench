import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { referenceExcerpt } from './research-reference.js';
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
test('reference preserves missing versus zero, observed time and non-adoption boundary',()=>{
  const text=referenceExcerpt({noteId:'a',title:'测试标题',likes:0,collects:null,shares:5,observedAt:'2026-09-26T01:00:00Z'});
  assert.match(text,/点赞 0 · 收藏 未采到 · 转发 5/);
  assert.match(text,/2026-09-26T01:00:00Z/);
  assert.match(text,/不代表原文完整读取/);
});
test('adding a reference appends rather than overwrites, repeated click is idempotent',()=>{
  const body=app.match(/el\("research-examples"\)\.addEventListener\("click", event => \{([\s\S]*?)\n\}\);/)[1];
  let saves=0;
  const input={value:'我的原有想法',dispatchEvent:()=>saves++,focus:()=>{}};
  const context={event:{target:{closest:()=>({dataset:{referenceIndex:'0'}})}},researchExamples:[{noteId:'a',title:'参考'}],referenceExcerpt,el:()=>input,Event:class{}};
  runInNewContext(`(()=>{${body}})()`,context); const once=input.value;
  runInNewContext(`(()=>{${body}})()`,context);
  assert.equal(input.value,once); assert.ok(once.startsWith('我的原有想法\n\n')); assert.equal(saves,1);
});
test('failed-save draft survives direction switch, legacy text remains readable',()=>{
  const source=app.match(/function renderResearchWorkspace\(\) \{[\s\S]*?\n\}\nfor \(const id/)[0].replace(/\nfor \(const id$/,'');
  const fields={};
  const el=id=>fields[id]??=( {value:'',dataset:{},querySelectorAll:()=>[]} );
  el('research-purpose').value='topic';el('research-scope').value='direction';el('research-window').value='24';
  const context={el,state:{marketState:{direction:'A'}},workComparison:{setContext(){}},researchDrafts:new Map(),localStorage:{getItem:()=> '旧复盘'},buildResearchWorkspace:()=>({coverage:{total:0,complete:0},comparable:0,boundary:'',intent:{question:'',experiment:''},examples:[]})};
  runInNewContext(source+'\nrenderResearchWorkspace();',context);
  assert.equal(el('research-review').value,'旧复盘');
  el('research-review').value='保存失败但不能丢失';el('research-review-status').textContent='保存失败';
  context.state.marketState.direction='B';runInNewContext('renderResearchWorkspace()',context);
  context.state.marketState.direction='A';runInNewContext('renderResearchWorkspace()',context);
  assert.equal(el('research-review').value,'保存失败但不能丢失');
  assert.equal(el('research-review-status').textContent,'保存失败');
});
