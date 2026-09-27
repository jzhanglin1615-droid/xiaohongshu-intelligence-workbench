import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSelection, completenessMarkup, comparisonMarkup, timelineMarkup, renderComparison, renderMetricTimeline } from './evidence-charts.js';
const now='2026-09-26T12:00:00Z';
const history=[{observedAt:'2026-09-26T08:00:00Z',likes:100},{observedAt:'2026-09-26T09:00:00Z',likes:90},{observedAt:'2026-09-26T10:00:00Z',likes:90}];
test('timeline represents decrease and unchanged interval, missing never creates SVG',()=>{
  const html=timelineMarkup(history,'likes',24,'delta',now);
  assert.match(html,/decrease/);assert.match(html,/-10/);assert.match(html,/持平|neutral/);
  assert.doesNotMatch(timelineMarkup(history,'shares',24,'total',now),/<svg/);
  assert.match(timelineMarkup([history[0]],'likes',24,'delta',now),/仅一次观察/);
});
test('gaps do not form false continuous lines and exact observations remain accessible',()=>{
  const html=timelineMarkup([history[0],{observedAt:now,likes:120}],'likes',3,'total',now);
  assert.doesNotMatch(html,/class="sample-connection"/);
  assert.match(html,/查看精确数据/);
  const distant=timelineMarkup([{observedAt:'2026-09-26T01:00:00Z',likes:100},{observedAt:now,likes:200}],'likes',24,'total',now);
  assert.doesNotMatch(distant,/class="sample-connection"/);
});
test('direction change resets scope/filter but synchronization preserves choices',()=>{
  const state={marketState:{direction:'收纳'}};
  const config=chartSelection(state);config.key='shares';config.group='厨房';
  assert.equal(chartSelection(state).group,'厨房');
  state.marketState.direction='家常菜';assert.equal(chartSelection(state).group,null);
  assert.equal(chartSelection(state).key,'shares');
});
test('legacy completeness explicitly reports unverified, labels are escaped',()=>{
  assert.match(completenessMarkup({counters:{admittedCards:5}},[]),/未核验 <b>5/);
  const html=comparisonMarkup([{label:'<script>',delta:null,comparable:0,observed:1,start:now,end:now}],'likes',null);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/待观察/);
});
function mockDocument(id) {
  const host={innerHTML:''};
  return {host,getElementById:name=>name===id?host:null};
}
test('bar click links to contributing posts; metric and scope switches render new evidence',()=>{
  const recent=[{observedAt:new Date(Date.now()-3600000).toISOString(),likes:10},{observedAt:new Date().toISOString(),likes:20}];
  const row={noteId:'n1',title:'实测帖子',sourceScope:'搜索结果：厨房',metricHistory:recent};
  const state={marketHours:24,marketState:{direction:'收纳'},marketTopics:{direction:[{rows:[row]}],all:[]}};
  const document=mockDocument('topic-comparison-chart');
  renderComparison(state,document);
  document.host.onclick({target:{closest:()=>({dataset:{chartGroup:'厨房'}})}});
  assert.match(document.host.innerHTML,/data-note-id="n1"/);
  document.host.onchange({target:{matches:s=>s==='[data-chart-key]',value:'shares'}});
  assert.match(document.host.innerHTML,/没有带时间戳/);
  assert.equal(state.evidenceCharts.group,null);
});
test('detail selector changes graph, shared window control is invoked',()=>{
  const state={marketHours:24,selectedId:'n',liveRanking:{rows:[{noteId:'n',metricHistory:history}]}};
  const document=mockDocument('post-metric-chart');let clicked='';
  let placedBeforeTable=false;
  document.querySelector=selector=>selector==='#detail-content .detail-changes'
    ? {before(host){placedBeforeTable=host===document.host;}}
    : {click(){clicked=selector;state.marketHours=72;}};
  renderMetricTimeline(state,document);
  assert.equal(placedBeforeTable,true);
  document.host.onchange({target:{matches:s=>s==='[data-detail-hours]',value:'72'}});
  assert.match(clicked,/72/); assert.equal(state.marketHours,72);
  document.host.onchange({target:{matches:s=>s==='[data-detail-mode]',value:'delta'}});
  assert.equal(state.evidenceCharts.mode,'delta');
});
