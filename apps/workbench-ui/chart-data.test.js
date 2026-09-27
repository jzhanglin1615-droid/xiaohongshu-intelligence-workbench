import test from 'node:test';
import assert from 'node:assert/strict';
import { metricSeries, windowStats, compareTopics, collectionCompleteness } from './chart-data.js';
const now = '2026-09-26T12:00:00Z';
const point = (hour, likes, extra={}) => ({observedAt:`2026-09-26T${hour}:00:00Z`, likes, ...extra});
test('separate unchanged observations survive; same time evidence is merged', () => {
  const series = metricSeries([point('08',100),point('09',120),point('10',120),point('10',120)],'likes');
  assert.equal(series.length,3);
  assert.equal(series.at(-1).value-series.at(-2).value,0);
});
test('window excludes old and future points; single snapshot is not growth', () => {
  const history=[{observedAt:'2026-09-24T12:00:00Z',likes:50},point('10',100),{observedAt:'2026-09-27T12:00:00Z',likes:200}];
  assert.equal(windowStats(history,'likes',24,now).delta,null);
  assert.equal(windowStats(history,'likes',72,now).delta,50);
});
test('missing, negative invalid counts and zero are distinct; decrease is retained', () => {
  assert.deepEqual(metricSeries([point('08',null),point('09',-1),point('10',0)],'likes').map(p=>p.value),[0]);
  assert.equal(windowStats([point('08',100),point('10',90)],'likes',24,now).delta,-10);
});
test('compare only same-post observed changes, not single newly found posts', () => {
  const groups=compareTopics([{noteId:'a',sourceScope:'搜索结果：收纳',metricHistory:[point('08',10),point('10',20)]},{noteId:'b',sourceScope:'搜索结果：收纳',metricHistory:[point('10',999)]}], 'likes',24,now);
  assert.equal(groups[0].delta,10); assert.equal(groups[0].comparable,1); assert.equal(groups[0].observed,2);
  assert.deepEqual(groups[0].contributors.map(r=>r.noteId),['a']);
});
test('collection partitions complete, queued gaps, unresolved and legacy unknown', () => {
  const result=collectionCompleteness({runId:'r',counters:{admittedCards:4},metricGaps:{a:[],b:['shares'],c:['collects']}},[{context:{runId:'r',noteId:'b'},expectedPageType:'NOTE_DETAIL',status:'QUEUED'}]);
  assert.deepEqual(result,{total:4,complete:1,pending:1,missing:1,unknown:1});
});
