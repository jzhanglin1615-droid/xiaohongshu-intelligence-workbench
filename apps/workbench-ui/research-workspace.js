import { buildMarketTopics } from './market-trends.js';
import { rankingCoverage, rankingFacts } from './ranking-evidence.js';

export const researchPurposes = {
  topic: { label: '决定下一篇研究什么', metric: 'likes', question: '比较标题承诺与受众问题，选择一个你能用真实经验回答的问题。', experiment: '下一篇只验证一个选题问题；记录发布时间、观察时长与实际互动。' },
  value: { label: '研究什么内容值得收藏', metric: 'collects', question: '打开原文核对步骤、清单或资料是否可执行，不把收藏量直接等同于内容质量。', experiment: '在同类选题中测试更具体的步骤或清单，再对照自己同观察时长的作品。' },
  share: { label: '研究什么内容值得转发', metric: 'shares', question: '核对原文解决了谁的问题、可能被分享给谁；转发量本身不能证明传播原因。', experiment: '测试一个明确的分享对象或使用场景，记录实际转发变化，不照搬原文。' },
};

export function buildResearchWorkspace(rows, { purpose = 'topic', scope = 'direction', direction = '', preciseTerms = [], windowHours = 24, now } = {}) {
  const intent = researchPurposes[purpose] ?? researchPurposes.topic;
  const topics = buildMarketTopics(rows, { direction, preciseTerms, windowHours, now });
  const groups = scope === 'all' ? topics.all : topics.direction;
  const unique = new Map(groups.flatMap(group => group.rows).map(row => [row.noteId, row]));
  const sample = [...unique.values()];
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const comparable = sample.filter(row => valid(row[intent.metric]));
  comparable.sort((a, b) => b[intent.metric] - a[intent.metric] || String(a.noteId).localeCompare(String(b.noteId)));
  return { intent, coverage: rankingCoverage(sample), comparable: comparable.length,
    missing: sample.length - comparable.length,
    examples: comparable.slice(0, 3).map(row => ({ ...row, facts: rankingFacts(row) })),
    boundary: scope !== 'all' && !direction.trim() ? '先保存研究方向，或切换全站样本。' : '按最近观察时间筛选；累计互动只用于挑选研究样本，不代表期间新增，也不证明适合你的账号。' };
}
