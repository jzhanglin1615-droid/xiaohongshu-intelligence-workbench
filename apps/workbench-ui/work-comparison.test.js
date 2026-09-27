import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWorks, comparisonKey } from './work-comparison.js';
const valid = () => ({ current:{title:'新作品',hours:24,likes:120,collects:10,shares:0},baseline:{title:'基准',hours:24,likes:100,collects:20,shares:0},comparable:true });
test('真实涨跌与零值，不凭差异断言有效', () => {
  const result=compareWorks(valid());
  assert.equal(result.complete,true);
  assert.deepEqual(result.values.map(x=>x.delta),[20,-10,0]);
  assert.deepEqual(result.values.map(x=>x.percent),[20,-50,null]);
  assert.match(result.conclusion,/不能据此确认/);
});
test('缺失、无效、布尔值不补零', () => {
  for(const value of ['',null,undefined,-1,1.5,'未知',true,Infinity]) {
    const draft=valid(); draft.current.likes=value;
    const result=compareWorks(draft);
    assert.equal(result.complete,false); assert.equal(result.values[0].delta,null);
  }
});
test('观察时长与同类确认是计算门槛', () => {
  for(const update of [d=>d.current.hours=48,d=>d.current.hours='',d=>d.comparable=false,d=>d.current.title='']) {
    const draft=valid();update(draft);
    assert.ok(compareWorks(draft).values.every(x=>x.delta===null));
  }
});
test('零基准只算绝对差，不制造无限增长率',()=>{
  const draft=valid();draft.current.shares=5;
  const metric=compareWorks(draft).values[2];
  assert.equal(metric.delta,5);assert.equal(metric.percent,null);
});
test('方向范围用途隔离且分隔符不碰撞',()=>{
  assert.notEqual(comparisonKey('a:b','c','d'),comparisonKey('a','b:c','d'));
  assert.notEqual(comparisonKey('a','all','topic'),comparisonKey('b','all','topic'));
});
