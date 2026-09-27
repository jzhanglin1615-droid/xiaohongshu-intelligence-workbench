// Preserve the observed evidence, not a claim that the source was fully read or adopted.
export function referenceExcerpt(row) {
  const metric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? '未采到' : Number(value).toLocaleString('zh-CN');
  return [
    `参考作品：${row.title || '未命名作品'}`,
    `帖子标识：${row.noteId || '未知'}`,
    `数据观察时间：${row.observedAt || row.lastSeenAt || '未知'}`,
    `当时累计：点赞 ${metric(row.likes)} · 收藏 ${metric(row.collects)} · 转发 ${metric(row.shares)}`,
    '证据边界：仅保存当前已采字段，不代表原文完整读取、内容采纳或增长证明。',
    '我核对到的做法：',
    '下一篇只尝试：',
  ].join('\n');
}
