import {
  CONTRACT_VERSION,
  assertContract,
  type CanonicalNote,
  type NoteCompletenessLedger,
  type QualityDecision,
  type RankingLedger,
  type ViralCandidateAssessment,
} from "../../contracts/src/index.ts";

export const VIRAL_FORMULA_VERSION = "offline-relative-v1";

export interface ViralAssessmentInput {
  scopeId: string;
  notes: CanonicalNote[];
  qualityDecisions: QualityDecision[];
  completenessLedgers: NoteCompletenessLedger[];
  rankingLedger: RankingLedger;
  assessedAt: string;
  minimumSampleSize?: number;
}

function median(values: Array<number | null>): { median: number | null; sampleSize: number } {
  const available = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (available.length === 0) return { median: null, sampleSize: 0 };
  const middle = Math.floor(available.length / 2);
  const value = available.length % 2 === 0 ? (available[middle - 1] + available[middle]) / 2 : available[middle];
  return { median: value, sampleSize: available.length };
}

function relativeComponent(value: number | null, baseline: number | null): number {
  if (value === null || baseline === null) return 0;
  if (baseline === 0) return value === 0 ? 50 : 100;
  return Math.round(Math.min(100, (value / baseline) * 50));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function assessViralCandidates(input: ViralAssessmentInput): ViralCandidateAssessment[] {
  const minimumRequired = input.minimumSampleSize ?? 3;
  const qualityById = new Map(input.qualityDecisions.map((item) => [item.entityId, item]));
  const completenessById = new Map(input.completenessLedgers.map((item) => [item.noteId, item]));
  const signalsById = new Map(input.rankingLedger.latestSignals.map((item) => [item.noteId, item]));
  const latestSnapshot = input.rankingLedger.snapshots.at(-1);
  const rankingEvidenceById = new Map((latestSnapshot?.entries ?? []).map((entry) => [entry.noteId, entry.sourceEnvelopeId]));
  const baseline = {
    method: "MEDIAN" as const,
    likes: median(input.notes.map((note) => note.metrics.likes)),
    collects: median(input.notes.map((note) => note.metrics.collects)),
    comments: median(input.notes.map((note) => note.metrics.comments)),
  };
  const missingMetrics = input.notes.reduce((count, note) => count
    + [note.metrics.likes, note.metrics.collects, note.metrics.comments].filter((value) => value === null).length, 0);
  const missingMetricRatio = input.notes.length === 0 ? 1 : missingMetrics / (input.notes.length * 3);
  const eligibleNotes = input.notes.filter((note) => {
    const quality = qualityById.get(note.noteId);
    const completeness = completenessById.get(note.noteId);
    return quality?.decision !== "BLOCK" && (completeness?.overallStatus === "COMPLETE" || completeness?.overallStatus === "PROVISIONAL");
  }).length;
  const engagement = new Map(input.notes.map((note) => [note.noteId,
    (note.metrics.likes ?? 0) + (note.metrics.collects ?? 0) + (note.metrics.comments ?? 0)]));
  const window = {
    startedAt: input.rankingLedger.snapshots.at(0)?.observedAt ?? input.assessedAt,
    endedAt: latestSnapshot?.observedAt ?? input.assessedAt,
  };

  return input.notes.map((note) => {
    const quality = qualityById.get(note.noteId);
    const completeness = completenessById.get(note.noteId);
    const rankingSignal = signalsById.get(note.noteId);
    const limitations: string[] = [];
    if (!quality) limitations.push("缺少质量判定");
    else if (quality.decision === "BLOCK") limitations.push(...quality.issues.filter((issue) => issue.severity === "BLOCK").map((issue) => `质量阻断：${issue.code}`));
    if (!completeness) limitations.push("缺少详情与评论完整度台账");
    else if (!["COMPLETE", "PROVISIONAL"].includes(completeness.overallStatus)) limitations.push(`采集完整度不足：${completeness.overallStatus}`);
    if (!rankingSignal) limitations.push("当前榜单快照没有该笔记的可解释信号");
    if (input.notes.length < minimumRequired) limitations.push(`样本量 ${input.notes.length} 低于最低要求 ${minimumRequired}`);
    const noteMetrics = [note.metrics.likes, note.metrics.collects, note.metrics.comments];
    if (noteMetrics.some((value) => value === null)) limitations.push("互动指标存在缺失值");

    const blocked = quality?.decision === "BLOCK" || (completeness && !["COMPLETE", "PROVISIONAL"].includes(completeness.overallStatus));
    const insufficient = !blocked && (input.notes.length < minimumRequired || !rankingSignal || noteMetrics.some((value) => value === null));
    const status = blocked ? "BLOCKED" : insufficient ? "INSUFFICIENT_EVIDENCE" : "ELIGIBLE";
    const engagementComponents = [
      relativeComponent(note.metrics.likes, baseline.likes.median),
      relativeComponent(note.metrics.collects, baseline.collects.median),
      relativeComponent(note.metrics.comments, baseline.comments.median),
    ];
    const scoreComponents = status === "ELIGIBLE" ? {
      ranking: rankingSignal!.priorityScore,
      engagement: Math.round(engagementComponents.reduce((sum, value) => sum + value, 0) / engagementComponents.length),
      persistence: Math.min(100, rankingSignal!.consecutiveAppearances * 25),
      evidence: completeness?.overallStatus === "COMPLETE" ? 100 : 70,
    } : null;
    const score = scoreComponents === null ? null : Math.round(
      scoreComponents.ranking * 0.35 + scoreComponents.engagement * 0.4
      + scoreComponents.persistence * 0.1 + scoreComponents.evidence * 0.15,
    );
    const evidenceEnvelopeIds = unique([
      ...note.provenance.envelopeIds,
      ...(completeness?.detail.evidenceEnvelopeIds ?? []),
      ...(completeness?.comments.evidenceEnvelopeIds ?? []),
      ...(rankingEvidenceById.get(note.noteId) ? [rankingEvidenceById.get(note.noteId)!] : []),
    ]).sort();
    const counterexampleNoteIds = input.notes
      .filter((candidate) => candidate.noteId !== note.noteId)
      .sort((a, b) => (engagement.get(b.noteId) ?? 0) - (engagement.get(a.noteId) ?? 0) || a.noteId.localeCompare(b.noteId))
      .slice(0, 2)
      .map((candidate) => candidate.noteId);
    const assessment: ViralCandidateAssessment = {
      schemaVersion: CONTRACT_VERSION,
      assessmentId: `viral:${input.scopeId}:${note.noteId}:${VIRAL_FORMULA_VERSION}`,
      scopeId: input.scopeId,
      noteId: note.noteId,
      status,
      score,
      formulaVersion: VIRAL_FORMULA_VERSION,
      observationWindow: window,
      sample: { totalNotes: input.notes.length, eligibleNotes, minimumRequired, missingMetricRatio },
      rawMetrics: {
        likes: note.metrics.likes,
        collects: note.metrics.collects,
        comments: note.metrics.comments,
        currentRank: rankingSignal?.currentRank ?? null,
        rankDelta: rankingSignal?.rankDelta ?? null,
        consecutiveAppearances: rankingSignal?.consecutiveAppearances ?? 0,
      },
      baseline,
      scoreComponents,
      signals: unique([
        rankingSignal ? `榜单信号：${rankingSignal.kind}` : "榜单信号缺失",
        scoreComponents ? `互动相对中位数得分：${scoreComponents.engagement}` : "未生成综合分",
        completeness ? `证据完整度：${completeness.overallStatus}` : "完整度未知",
      ]),
      limitations: unique(limitations),
      evidenceEnvelopeIds,
      counterexampleNoteIds,
      assessedAt: input.assessedAt,
    };
    assertContract<ViralCandidateAssessment>("ViralCandidateAssessment", assessment);
    return assessment;
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.noteId.localeCompare(b.noteId));
}
