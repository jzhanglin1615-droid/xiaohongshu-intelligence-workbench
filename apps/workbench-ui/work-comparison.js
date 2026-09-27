const metrics = [['likes', '点赞'], ['collects', '收藏'], ['shares', '转发']];
const count = value => {
  if (!['string', 'number'].includes(typeof value)) return null;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const hours = value => {
  if (!['string', 'number'].includes(typeof value)) return null;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function compareWorks(draft = {}) {
  const current = draft.current ?? {};
  const baseline = draft.baseline ?? {};
  const warnings = [];
  if (!String(current.title ?? '').trim() || !String(baseline.title ?? '').trim()) warnings.push('填写两篇作品的名称或地址，避免比较对象混淆。');
  const currentHours = hours(current.hours), baselineHours = hours(baseline.hours);
  if (currentHours === null || baselineHours === null) warnings.push('填写两篇作品发布后经过的观察小时数。');
  else if (currentHours !== baselineHours) warnings.push('观察时长不同，暂不计算涨跌；请补录同一观察时长的数据。');
  if (draft.comparable !== true) warnings.push('请先确认两篇作品属于同账号、相近选题与内容形式。');
  const comparable = warnings.length === 0;
  const values = metrics.map(([key, label]) => {
    const value = count(current[key]), base = count(baseline[key]);
    const delta = comparable && value !== null && base !== null ? value - base : null;
    return { key, label, value, base, delta, percent: delta === null || base === 0 ? null : delta / base * 100 };
  });
  const missing = values.filter(item => item.value === null || item.base === null);
  if (missing.length) warnings.push(`待补数据：${missing.map(item => item.label).join('、')}。空白与无效输入不会当作 0。`);
  return { values, warnings, comparable, complete: comparable && missing.length === 0,
    conclusion: comparable ? '仅表示这两篇作品的数值差异；未控制曝光、人群与发布时间，不能据此确认改动有效。' : '先补齐可比条件，再观察差异；不会用不同观察时长的累计数据推导效果。' };
}

export function comparisonKey(direction, scope, purpose) {
  return `xhs-work-comparison-v1:${JSON.stringify([direction || '', scope, purpose])}`;
}

// A local, optional worksheet. No network, model calls, automatic ranking changes or account assumptions.
export function mountWorkComparison(root, { storage, onExport } = {}) {
  const drafts = new Map();
  let activeKey = null;
  let context = {};
  const form = root.querySelector('[data-comparison-form]');
  const output = root.querySelector('[data-comparison-output]');
  const status = root.querySelector('[data-comparison-status]');
  for (const side of ['current', 'baseline']) {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = side === 'current' ? '这次作品' : '基准作品'; row.append(heading);
    for (const [field, label] of [['title','名称或地址'],['hours','观察小时'],...metrics]) {
      const cell = document.createElement('td'), input = document.createElement('input');
      input.name = `${side}.${field}`;
      input.type = field === 'title' ? 'text' : 'number';
      input.setAttribute('aria-label', `${heading.textContent} · ${label}`);
      if (field !== 'title') { input.min = field === 'hours' ? '0.01' : '0'; input.step = field === 'hours' ? 'any' : '1'; }
      input.placeholder = field === 'title' ? '填写名称或原文地址' : '未填';
      cell.append(input); row.append(cell);
    }
    form.querySelector('tbody').append(row);
  }
  const read = () => {
    const draft = { current:{}, baseline:{}, comparable: form.elements.namedItem('comparable').checked };
    for (const side of ['current','baseline']) for (const field of ['title','hours','likes','collects','shares']) draft[side][field] = form.elements.namedItem(`${side}.${field}`).value;
    return draft;
  };
  const show = () => {
    const result = compareWorks(read()); output.replaceChildren();
    const list = document.createElement('div'); list.className = 'comparison-deltas';
    for (const item of result.values) {
      const cell = document.createElement('div');
      const label = document.createElement('span'); label.textContent = item.label;
      const value = document.createElement('strong');
      value.className = item.delta === null || item.delta === 0 ? '' : item.delta > 0 ? 'comparison-up' : 'comparison-down';
      value.textContent = item.delta === null ? '待比较' : item.delta === 0 ? '持平 0' : `${item.delta > 0 ? '↑ +' : '↓ −'}${Math.abs(item.delta).toLocaleString('zh-CN')}`;
      const detail = document.createElement('small');
      detail.textContent = item.delta === null ? '需补齐数据与可比条件' : item.base === 0 ? '基准为 0，不计算百分比' : `较基准 ${item.percent > 0 ? '+' : ''}${item.percent.toFixed(1)}%`;
      cell.append(label,value,detail); list.append(cell);
    }
    output.append(list);
    for (const warning of [...result.warnings, result.conclusion]) { const p = document.createElement('p'); p.textContent = warning; output.append(p); }
  };
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => {
    if (!activeKey) return;
    const draft = read(); drafts.set(activeKey, draft); show();
    try { storage.setItem(activeKey, JSON.stringify(draft)); status.textContent = '对照已保存到此浏览器；可导出备份。'; }
    catch { status.textContent = '本地保存失败，输入暂留当前页面；请导出备份后再关闭。'; }
  });
  root.querySelector('[data-comparison-export]').addEventListener('click', () => {
    try { onExport({ schemaVersion:1, context, draft:read(), comparison:compareWorks(read()), exportedAt:new Date().toISOString(), source:'USER_ENTERED_NOT_PLATFORM_VERIFIED' }); status.textContent = '已发起对照记录下载；请确认浏览器保存结果。'; }
    catch { status.textContent = '导出失败，请复制保留输入。'; }
  });
  return { setContext(next) {
    const key = comparisonKey(next.direction,next.scope,next.purpose);
    if (key === activeKey) return;
    if (activeKey) drafts.set(activeKey,read());
    context = { ...next }; activeKey = key;
    let draft = drafts.get(key), message = '手动录入，仅本地保存；不会读取或操作账号。';
    if (!draft) {
      try {
        const raw = storage.getItem(key); draft = raw ? JSON.parse(raw) : {};
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw Error('invalid data');
      } catch { draft = {}; message = '无法读取已保存记录，旧存储未改写；可重新填写，但请先保留原记录。'; }
    }
    for (const side of ['current','baseline']) for (const field of ['title','hours','likes','collects','shares']) form.elements.namedItem(`${side}.${field}`).value = String(draft[side]?.[field] ?? '');
    form.elements.namedItem('comparable').checked = draft.comparable === true;
    status.textContent = message; show();
  } };
}
