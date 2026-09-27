import { collectionCompleteness, compareTopics, windowStats, metricSeries } from './chart-data.js';

const names = {likes:'点赞',collects:'收藏',shares:'转发'};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => new Intl.NumberFormat('zh-CN').format(value);
const stamp = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '无观察';
const signed = value => value===null ? '待观察' : `${value>0?'↑ +':value<0?'↓ ':''}${num(value)}${value===0?' · 持平':''}`;
const tone = value => value===null?'insufficient':value>0?'increase':value<0?'decrease':'neutral';
const options = (items,value) => Object.entries(items).map(([id,label])=>`<option value="${id}"${value===id?' selected':''}>${label}</option>`).join('');

export function chartSelection(state) {
  const direction=state.marketState?.direction ?? '';
  const selection=state.evidenceCharts ??= {direction,scope:direction?'direction':'all',key:'likes',group:null,detailKey:'likes',mode:'total'};
  if(selection.direction!==direction) Object.assign(selection,{direction,scope:direction?'direction':'all',group:null});
  return selection;
}
function mount(document,id,parent,heading) {
  let host=document.getElementById(id);
  if(!host) {
    const target=document.getElementById(parent);
    if(!target) return null;
    host=document.createElement('section'); host.id=id; host.className='evidence-chart';
    host.setAttribute('aria-label',heading); target.append(host);
  }
  return host;
}
export function completenessMarkup(job,tasks) {
  const data=collectionCompleteness(job,tasks);
  const segments=[['complete','三项齐全',data.complete],['pending','待补采',data.pending],['missing','仍缺指标',data.missing],['unknown','未核验',data.unknown]];
  return `<div class="chart-heading"><h3>互动数据完整度</h3><span>本轮候选 ${num(data.total)} 条</span></div><div class="completeness-track" role="img" aria-label="${segments.map(([,label,count])=>`${label}${count}条`).join('，')}">${segments.map(([key,,count])=>`<span class="${key}" style="width:${data.total?count/data.total*100:0}%"></span>`).join('')}</div><div class="chart-legend">${segments.map(([key,label,count])=>`<span><i class="${key}"></i>${label} <b>${num(count)}</b></span>`).join('')}</div><p class="chart-note">齐全 = 点赞、收藏、转发均有实测值；不代表已采到全文。${data.total?'缺失不按 0 处理。':'尚未获得本轮数据。'}</p>`;
}
export function renderCompleteness(job,tasks,document) {
  const host=mount(document,'collection-completeness-chart','collection-live-card','互动数据完整度');
  if(host) host.innerHTML=completenessMarkup(job,tasks);
}
export function comparisonMarkup(groups,key,selection) {
  const max=Math.max(1,...groups.map(group=>Math.abs(group.delta ?? 0)));
  return groups.length ? `<p class="chart-note">比较窗口内同帖${names[key]}净变化，不计新发现帖子的累计量。各组观测跨度可能不同；这是搜索主题分组，不是自动语义分类。</p><div class="comparison-rows">${groups.map(group=>`<button type="button" class="comparison-row ${tone(group.delta)}" data-chart-group="${esc(group.label)}" aria-pressed="${selection===group.label}"><span class="comparison-label">${esc(group.label)}<small>可比 ${group.comparable} / 已观察 ${group.observed} 条</small></span><span class="comparison-bar"><i style="width:${Math.abs(group.delta ?? 0)/max*100}%"></i></span><strong>${signed(group.delta)}</strong><small>${stamp(group.start)} — ${stamp(group.end)}</small></button>`).join('')}</div>` : '<p class="chart-empty">此范围没有带时间戳的指标观察。同步不会生成新证据；完成新一轮检查后才会出现数据。</p>';
}
export function renderComparison(state,document) {
  const config=chartSelection(state);
  const host=mount(document,'topic-comparison-chart','direction-ranking','搜索主题增长对比');
  if(!host) return;
  const rows=(state.marketTopics?.[config.scope] ?? []).flatMap(topic=>topic.rows);
  const groups=compareTopics(rows,config.key,state.marketHours);
  if(!groups.some(group=>group.label===config.group)) config.group=null;
  const selected=groups.find(group=>group.label===config.group);
  host.innerHTML=`<div class="chart-heading"><div><h3>搜索主题增长对比</h3><p>近 ${state.marketHours===24?'24 小时':`${state.marketHours/24} 天`} · ${config.scope==='direction'?esc(config.direction):'本地全站样本'}</p></div><div class="chart-controls"><label>范围<select data-chart-scope>${options({...config.direction?{direction:'当前方向'}:{},all:'全站样本'},config.scope)}</select></label><label>指标<select data-chart-key>${options(names,config.key)}</select></label></div></div>${comparisonMarkup(groups,config.key,config.group)}${selected?`<div class="chart-contributors"><h4>${esc(selected.label)} · 可比帖子 ${selected.comparable} 条</h4>${selected.contributors.map(row=>`<button class="open-note-detail chart-contributor" data-note-id="${esc(row.noteId)}" type="button"><span>${esc(row.title)}</span><strong class="${tone(row.chartDelta)}">${signed(row.chartDelta)}</strong><small>${stamp(row.chartStart)} — ${stamp(row.chartEnd)}</small></button>`).join('') || '<p>尚无两次有效观察，不能判断增长。</p>'}</div>`:''}`;
  host.onchange=event=>{
    if(event.target.matches('[data-chart-scope]')) {config.scope=event.target.value;config.group=null;}
    if(event.target.matches('[data-chart-key]')) config.key=event.target.value;
    renderComparison(state,document);
  };
  host.onclick=event=>{
    const button=event.target.closest('[data-chart-group]');
    if(!button) return;
    config.group=config.group===button.dataset.chartGroup?null:button.dataset.chartGroup;
    renderComparison(state,document);
  };
}
export function timelineMarkup(history,key,hours,mode,now=new Date().toISOString()) {
  const stats=windowStats(history,key,hours,now);
  const points=stats.points;
  const values=mode==='delta'?points.slice(1).map((p,i)=>({...p,value:p.value-points[i].value,from:points[i].observedAt,gapHours:(p.time-points[i].time)/3600000})):points;
  const lastKnown=metricSeries(history,key).filter(p=>p.time<=Date.parse(now)).at(-1);
  const summary=`<p class="chart-note">${points.length} 次有效观察 · 实际覆盖 ${stats.durationHours.toFixed(1)} 小时 · 最近 ${stamp(stats.end)} · 窗口净变化 <b class="${tone(stats.delta)}">${signed(stats.delta)}</b>${!points.length && lastKnown ? ` · 旧数据 ${num(lastKnown.value)}（${stamp(lastKnown.observedAt)}，窗口外，不参与计算）` : ''}</p>`;
  if(!values.length) return summary+`<p class="chart-empty">${points.length?'仅一次观察，不能计算变化。':'所选时间窗内此指标没有有效观察；不按 0 绘制。'}</p>`;
  const min=Math.min(0,...values.map(p=>p.value)),max=Math.max(1,...values.map(p=>p.value));
  const first=points[0].time,last=points.at(-1).time;
  const x=p=>60+(last===first?0.5:(p.time-first)/(last-first))*800;
  const y=p=>180-(p.value-min)/(max-min)*150;
  // Connecting samples is not continuous monitoring. Long gaps stay disconnected.
  const lines=mode==='total'?values.slice(1).map((p,i)=>(p.time-values[i].time)>hours*3600000/6?'':`<line class="sample-connection" x1="${x(values[i])}" y1="${y(values[i])}" x2="${x(p)}" y2="${y(p)}"/>`).join(''):'';
  const markers=values.map(p=>`${mode==='delta'?`<line class="${tone(p.value)}" x1="${x(p)}" x2="${x(p)}" y1="${y({value:0})}" y2="${y(p)}"/>`:''}<circle class="${mode==='delta'?tone(p.value):'neutral'}" cx="${x(p)}" cy="${y(p)}" r="5"><title>${stamp(p.observedAt)} · ${names[key]} ${num(p.value)}${p.from?`（自 ${stamp(p.from)}，${p.gapHours.toFixed(1)} 小时）`:''}</title></circle>`).join('');
  return summary+`<svg class="metric-timeline" viewBox="0 0 940 220" role="img" aria-label="${names[key]}${mode==='delta'?'区间净变化':'累计量'}，${values.length}个真实观察点"><line class="chart-axis" x1="60" y1="180" x2="860" y2="180"/><text x="4" y="34">${num(max)}</text><text x="4" y="180">${num(min)}</text>${lines}${markers}<text x="60" y="212">${stamp(stats.start)}</text><text x="860" y="212" text-anchor="end">${stamp(stats.end)}</text></svg><p class="chart-note">${mode==='delta'?'每段变化按两次观察之间计算，不同间隔不能直接当作增长速度。':'虚线仅连接采样点，不代表连续监测；大于所选窗口 1/6 的间隔断开。'} 单点不推断趋势。</p><details class="chart-data-table"><summary>查看精确数据（${values.length} 条）</summary><table><thead><tr><th>观察时间</th><th>${names[key]}${mode==='delta'?'变化':'累计'}</th><th>比较起点</th></tr></thead><tbody>${values.map(p=>`<tr><td>${stamp(p.observedAt)}</td><td class="${mode==='delta'?tone(p.value):'neutral'}">${num(p.value)}</td><td>${p.from?stamp(p.from):'—'}</td></tr>`).join('')}</tbody></table></details>`;
}
export function renderMetricTimeline(state,document) {
  const row=state.liveRanking?.rows?.find(item=>item.noteId===state.selectedId);
  if(!row) return;
  const host=mount(document,'post-metric-chart','detail-content','帖子互动变化');
  if(!host) return;
  // Put the visual summary before the existing raw observation table.
  document.querySelector?.('#detail-content .detail-changes')?.before(host);
  const config=chartSelection(state);
  host.innerHTML=`<div class="chart-heading"><h3>帖子互动变化</h3><div class="chart-controls"><label>指标<select data-detail-key>${options(names,config.detailKey)}</select></label><label>显示<select data-detail-mode>${options({total:'累计量',delta:'区间变化'},config.mode)}</select></label><label>时间<select data-detail-hours>${options({'24':'24 小时','72':'3 天','168':'7 天'},String(state.marketHours))}</select></label></div></div>${timelineMarkup(row.metricHistory ?? [],config.detailKey,state.marketHours,config.mode)}`;
  host.onchange=event=>{
    if(event.target.matches('[data-detail-key]')) config.detailKey=event.target.value;
    if(event.target.matches('[data-detail-mode]')) config.mode=event.target.value;
    if(event.target.matches('[data-detail-hours]')) {
      // Use the existing period control to keep every board on the same window.
      document.querySelector(`[data-market-hours="${event.target.value}"]`)?.click();
    }
    renderMetricTimeline(state,document);
  };
}
