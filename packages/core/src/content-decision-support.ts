import {
  CONTRACT_VERSION,
  assertContract,
  type CanonicalNote,
  type ContentDecisionCard,
  type ViralCandidateAssessment,
} from "../../contracts/src/index.ts";

export function createContentDecisionCards(
  assessments: ViralCandidateAssessment[],
  notes: CanonicalNote[],
  createdAt: string,
): ContentDecisionCard[] {
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  return assessments.map((assessment) => {
    const note = notesById.get(assessment.noteId);
    if (!note) throw new Error(`Missing canonical note for assessment ${assessment.assessmentId}`);
    const status = assessment.status === "ELIGIBLE"
      ? "RESEARCH_READY"
      : assessment.status === "BLOCKED" ? "BLOCKED" : "INSUFFICIENT_EVIDENCE";
    const card: ContentDecisionCard = {
      schemaVersion: CONTRACT_VERSION,
      cardId: `decision:${assessment.assessmentId}`,
      assessmentId: assessment.assessmentId,
      noteId: note.noteId,
      status,
      opportunitySummary: status === "RESEARCH_READY"
        ? `“${note.title}”在当前离线样本和榜单范围内值得进入人工解读队列；这不是跨平台或未来表现预测。`
        : `“${note.title}”暂不进入作品决策队列，需先关闭证据缺口。`,
      audienceQuestionHypothesis: `待用评论证据验证：用户为何会对“${note.title}”所解决的问题产生收藏、追问或复用意愿？`,
      angleHypothesis: `拆解该样本提供的具体方法、结果证明与使用门槛，并与反例 ${assessment.counterexampleNoteIds.join("、") || "暂无"} 对照。`,
      openingHypotheses: [
        "先呈现可核验的结果或矛盾，再解释方法。",
        "用评论中的高频问题验证开头，而不是只复述标题。",
      ],
      structureHypotheses: [
        "证据钩子：榜单位置与原始互动指标。",
        "需求解释：评论问题、反对意见与使用情境。",
        "方法拆解：步骤、材料、门槛和可复现结果。",
        "差异验证：与同榜反例逐项比较。",
      ],
      materialRequirements: [
        "保留原始详情证据及时间戳。",
        "保留评论、回复展开与总数核对证据。",
        "准备可自主使用或已获授权的作品素材。",
      ],
      differentiationChecks: [
        "是否补充了原样本未回答的问题。",
        "是否有自己的验证、案例或数据，而非换词复述。",
        "是否符合后续经确认的账号方向和受众。",
      ],
      risks: [
        "离线夹具不能证明真实平台上的爆款概率。",
        "相关性不等于因果，互动量也不等于转化价值。",
        ...(assessment.status === "BLOCKED" ? ["当前证据被质量或完整度门禁阻断。"] : []),
      ],
      evidenceEnvelopeIds: assessment.evidenceEnvelopeIds,
      limitations: assessment.limitations.length > 0 ? assessment.limitations : ["账号方向仍为 UNSET，不能直接转成选题或成稿。"],
      requiresContentDirection: true,
      createdAt,
    };
    assertContract<ContentDecisionCard>("ContentDecisionCard", card);
    return card;
  });
}
