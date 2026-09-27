// Observation-only statistics. A missing value never becomes a measured zero.
const priority = { NORMALIZED_NOTE: 0, SEARCH_RESULTS: 1, NOTE_DETAIL: 2 };
export const validMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function metricSeries(history = [], key) {
  const observations = new Map();
  for (const item of history) {
    const time = Date.parse(item.observedAt);
    if (!Number.isFinite(time) || !validMetric(item[key])) continue;
    const old = observations.get(time);
    const rank = priority[item.source] ?? 0;
    if (!old || rank >= old.priority) observations.set(time, {time, observedAt:new Date(time).toISOString(),value:item[key],priority:rank});
  }
  return [...observations.values()].sort((a,b)=>a.time-b.time);
}
export function windowStats(history, key, hours=24, now=new Date().toISOString()) {
  const end = Date.parse(now), start = end - hours*3600000;
  const points = metricSeries(history,key).filter(p=>p.time>=start && p.time<=end);
  return {points, delta:points.length>1 ? points.at(-1).value-points[0].value : null,
    start:points[0]?.observedAt ?? null,end:points.at(-1)?.observedAt ?? null,
    durationHours:points.length>1 ? (points.at(-1).time-points[0].time)/3600000 : 0};
}
export function compareTopics(rows=[],key='likes',hours=24,now=new Date().toISOString()) {
  const groups=new Map();
  for (const row of rows) {
    const stats=windowStats(row.metricHistory ?? [],key,hours,now);
    if (!stats.points.length) continue;
    const label=String(row.sourceScope ?? '').replace(/^搜索结果[：:]\s*/, '').trim() || '未分类搜索';
    if (!groups.has(label)) groups.set(label,{label,delta:null,comparable:0,observed:0,contributors:[],start:stats.start,end:stats.end});
    const group=groups.get(label); group.observed++;
    if (stats.start<group.start) group.start=stats.start;
    if (stats.end>group.end) group.end=stats.end;
    if (stats.delta!==null) {
      group.delta=(group.delta ?? 0)+stats.delta; group.comparable++;
      group.contributors.push({...row,chartDelta:stats.delta,chartStart:stats.start,chartEnd:stats.end});
    }
  }
  return [...groups.values()].sort((a,b)=>(b.delta ?? -Infinity)-(a.delta ?? -Infinity));
}
export function collectionCompleteness(job,tasks=[]) {
  const entries=Object.entries(job?.metricGaps ?? {});
  const total=Math.max(entries.length,Number(job?.counters?.admittedCards ?? job?.counters?.ingestedCandidates ?? 0));
  let complete=0,pending=0,missing=0;
  for (const [noteId,gaps] of entries) {
    if (!gaps.length) complete++;
    else if (tasks.some(t=>t.context?.runId===job.runId && t.context?.noteId===noteId && t.expectedPageType==='NOTE_DETAIL' && ['QUEUED','LEASED','RUNNING'].includes(t.status))) pending++;
    else missing++;
  }
  return {total,complete,pending,missing,unknown:total-entries.length};
}
