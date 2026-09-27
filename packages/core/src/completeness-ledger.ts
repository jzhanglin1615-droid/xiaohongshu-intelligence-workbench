import {
  CONTRACT_VERSION,
  assertContract,
  type CompletenessStatus,
  type NoteCompletenessLedger,
  type ReplyThreadCompleteness,
} from "../../contracts/src/index.ts";

export type ObservationAccessState = "VISIBLE" | "INACCESSIBLE" | "DRIFTED" | "HUMAN_REQUIRED";

export interface ReplyThreadObservation {
  parentCommentId: string;
  declaredReplyCount: number | null;
  capturedReplyIds: string[];
  expansionExhausted: boolean;
}

export interface NoteCompletenessObservation {
  noteId: string;
  observedAt: string;
  detail: {
    access: ObservationAccessState;
    requiredFields: string[];
    presentFields: string[];
    evidenceEnvelopeIds: string[];
  };
  comments: {
    access: ObservationAccessState;
    platformDeclaredTotal: number | null;
    capturedTopLevelIds: string[];
    replyThreads: ReplyThreadObservation[];
    topLevelPaginationExhausted: boolean;
    nextCursor: string | null;
    evidenceEnvelopeIds: string[];
  };
}

const unique = (values: string[]): string[] => [...new Set(values.filter((value) => value.trim().length > 0))].sort();

function inaccessibleStatus(access: ObservationAccessState): CompletenessStatus | null {
  if (access === "INACCESSIBLE") return "INACCESSIBLE";
  if (access === "DRIFTED") return "DRIFTED";
  if (access === "HUMAN_REQUIRED") return "HUMAN_REQUIRED";
  return null;
}

function mergeReplyThreads(
  previous: ReplyThreadCompleteness[],
  observed: ReplyThreadObservation[],
): ReplyThreadCompleteness[] {
  const byParent = new Map(previous.map((thread) => [thread.parentCommentId, thread]));
  for (const thread of observed) {
    const before = byParent.get(thread.parentCommentId);
    const capturedReplyIds = unique([...(before?.capturedReplyIds ?? []), ...thread.capturedReplyIds]);
    const declaredReplyCount = thread.declaredReplyCount ?? before?.declaredReplyCount ?? null;
    const missingReplyCount = declaredReplyCount === null ? null : Math.max(0, declaredReplyCount - capturedReplyIds.length);
    byParent.set(thread.parentCommentId, {
      parentCommentId: thread.parentCommentId,
      declaredReplyCount,
      capturedReplyIds,
      capturedReplyCount: capturedReplyIds.length,
      expansionExhausted: Boolean(before?.expansionExhausted || thread.expansionExhausted),
      missingReplyCount,
    });
  }
  return [...byParent.values()].sort((a, b) => a.parentCommentId.localeCompare(b.parentCommentId));
}

export function evaluateNoteCompleteness(
  observation: NoteCompletenessObservation,
  previous: NoteCompletenessLedger | null = null,
): NoteCompletenessLedger {
  if (previous && previous.noteId !== observation.noteId) {
    throw new Error("Completeness observation noteId does not match the existing ledger.");
  }
  if (Number.isNaN(Date.parse(observation.observedAt))) throw new Error("observedAt must be a valid timestamp.");
  if (observation.comments.topLevelPaginationExhausted && observation.comments.nextCursor !== null) {
    throw new Error("An exhausted comment pagination observation cannot retain a next cursor.");
  }

  const requiredFields = unique([...(previous?.detail.requiredFields ?? []), ...observation.detail.requiredFields]);
  const presentFields = unique([...(previous?.detail.presentFields ?? []), ...observation.detail.presentFields]);
  const missingFields = requiredFields.filter((field) => !presentFields.includes(field));
  const detailBlocked = inaccessibleStatus(observation.detail.access);
  const detailStatus: CompletenessStatus = detailBlocked ?? (missingFields.length === 0 ? "COMPLETE" : "PARTIAL");

  const capturedTopLevelIds = unique([
    ...(previous?.comments.capturedTopLevelIds ?? []),
    ...observation.comments.capturedTopLevelIds,
  ]);
  const replyThreads = mergeReplyThreads(previous?.comments.replyThreads ?? [], observation.comments.replyThreads);
  const capturedReplyIds = unique(replyThreads.flatMap((thread) => thread.capturedReplyIds));
  const capturedUniqueIds = unique([...capturedTopLevelIds, ...capturedReplyIds]);
  const platformDeclaredTotal = observation.comments.platformDeclaredTotal ?? previous?.comments.platformDeclaredTotal ?? null;
  const countGap = platformDeclaredTotal === null ? null : Math.max(0, platformDeclaredTotal - capturedUniqueIds.length);
  const topLevelPaginationExhausted = Boolean(
    previous?.comments.topLevelPaginationExhausted || observation.comments.topLevelPaginationExhausted,
  );
  const unresolvedReplyThreads = replyThreads.filter((thread) =>
    !thread.expansionExhausted || (thread.missingReplyCount !== null && thread.missingReplyCount > 0)).length;
  const nextCursor = topLevelPaginationExhausted ? null : observation.comments.nextCursor;
  const commentsBlocked = inaccessibleStatus(observation.comments.access);
  let commentsStatus: CompletenessStatus;
  if (commentsBlocked) commentsStatus = commentsBlocked;
  else if (!topLevelPaginationExhausted || nextCursor !== null || unresolvedReplyThreads > 0 || (countGap !== null && countGap > 0)) {
    commentsStatus = "PARTIAL";
  } else if (platformDeclaredTotal === null) commentsStatus = "PROVISIONAL";
  else commentsStatus = "COMPLETE";

  const blocked = [detailStatus, commentsStatus].some((status) =>
    status === "INACCESSIBLE" || status === "DRIFTED" || status === "HUMAN_REQUIRED");
  const overallStatus: NoteCompletenessLedger["overallStatus"] = blocked
    ? "BLOCKED"
    : [detailStatus, commentsStatus].includes("PARTIAL")
      ? "PARTIAL"
      : [detailStatus, commentsStatus].includes("PROVISIONAL")
        ? "PROVISIONAL"
        : "COMPLETE";

  const ledger: NoteCompletenessLedger = {
    schemaVersion: CONTRACT_VERSION,
    noteId: observation.noteId,
    detail: {
      status: detailStatus,
      requiredFields,
      presentFields,
      missingFields,
      evidenceEnvelopeIds: unique([...(previous?.detail.evidenceEnvelopeIds ?? []), ...observation.detail.evidenceEnvelopeIds]),
    },
    comments: {
      status: commentsStatus,
      platformDeclaredTotal,
      capturedTopLevelIds,
      capturedReplyIds,
      capturedTopLevelCount: capturedTopLevelIds.length,
      capturedReplyCount: capturedReplyIds.length,
      capturedUniqueCount: capturedUniqueIds.length,
      countGap,
      topLevelPaginationExhausted,
      unresolvedReplyThreads,
      replyThreads,
      nextCursor,
      evidenceEnvelopeIds: unique([...(previous?.comments.evidenceEnvelopeIds ?? []), ...observation.comments.evidenceEnvelopeIds]),
    },
    overallStatus,
    observationCount: (previous?.observationCount ?? 0) + 1,
    updatedAt: observation.observedAt,
  };
  assertContract<NoteCompletenessLedger>("NoteCompletenessLedger", ledger);
  return ledger;
}
