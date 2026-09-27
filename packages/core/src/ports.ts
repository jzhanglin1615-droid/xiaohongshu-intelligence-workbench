import type {
  CanonicalNote,
  Checkpoint,
  CollectionRunLedger,
  ContentDecisionCard,
  EnrichmentPlan,
  ExportReceipt,
  QualityDecision,
  NoteCompletenessLedger,
  RankingLedger,
  RankingSnapshot,
  RawEnvelope,
  RetryQueueSnapshot,
  TaskError,
  TaskSpec,
  ViralCandidateAssessment,
} from "../../contracts/src/index.ts";

export interface Clock {
  now(): string;
}

export interface IdProvider {
  next(prefix: string): string;
}

export interface PlatformCollector {
  collectSearch(keyword: string, limit: number): Promise<RawEnvelope>;
  collectNote(noteId: string): Promise<RawEnvelope>;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
}

export interface EvidenceStore {
  saveRawEnvelopes(envelopes: RawEnvelope[]): Promise<void>;
  getRawEnvelope(envelopeId: string): Promise<RawEnvelope | null>;
  listRawEnvelopes(): Promise<RawEnvelope[]>;
  upsertNotes(notes: CanonicalNote[]): Promise<UpsertResult>;
  saveQuality(decisions: QualityDecision[]): Promise<void>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoint(taskId: string): Promise<Checkpoint | null>;
  saveRetryQueue(snapshot: RetryQueueSnapshot): Promise<void>;
  getRetryQueue(taskId: string): Promise<RetryQueueSnapshot | null>;
  saveRankingLedger(ledger: RankingLedger): Promise<void>;
  getRankingLedger(scopeId: string): Promise<RankingLedger | null>;
  saveCompletenessLedger(ledger: NoteCompletenessLedger): Promise<void>;
  getCompletenessLedger(noteId: string): Promise<NoteCompletenessLedger | null>;
  listCompletenessLedgers(): Promise<NoteCompletenessLedger[]>;
  saveEnrichmentPlan(plan: EnrichmentPlan): Promise<void>;
  getEnrichmentPlan(planId: string): Promise<EnrichmentPlan | null>;
  saveCollectionRunLedger(ledger: CollectionRunLedger): Promise<void>;
  getCollectionRunLedger(runId: string): Promise<CollectionRunLedger | null>;
  saveViralAssessments(assessments: ViralCandidateAssessment[]): Promise<void>;
  listViralAssessments(scopeId?: string): Promise<ViralCandidateAssessment[]>;
  saveContentDecisionCards(cards: ContentDecisionCard[]): Promise<void>;
  listContentDecisionCards(): Promise<ContentDecisionCard[]>;
  listNotes(): Promise<CanonicalNote[]>;
  listQuality(): Promise<QualityDecision[]>;
}

export interface DetailCollectionObservation {
  noteId: string;
  observedAt: string;
  access: "VISIBLE" | "INACCESSIBLE" | "DRIFTED" | "HUMAN_REQUIRED";
  requiredFields: string[];
  presentFields: string[];
  evidenceEnvelopeIds: string[];
}

export interface CommentReplyObservation {
  parentCommentId: string;
  declaredReplyCount: number | null;
  capturedReplyIds: string[];
  expansionExhausted: boolean;
}

export interface CommentsCollectionObservation {
  noteId: string;
  observedAt: string;
  access: "VISIBLE" | "INACCESSIBLE" | "DRIFTED" | "HUMAN_REQUIRED";
  platformDeclaredTotal: number | null;
  capturedTopLevelIds: string[];
  replyThreads: CommentReplyObservation[];
  topLevelPaginationExhausted: boolean;
  nextCursor: string | null;
  evidenceEnvelopeIds: string[];
}

export interface CollectionTargetResult {
  envelopes: RawEnvelope[];
  rankingSnapshot?: RankingSnapshot;
  detailObservation?: DetailCollectionObservation;
  commentsObservation?: CommentsCollectionObservation;
  canonicalNotes?: CanonicalNote[];
}

export interface CollectionTargetCollector {
  collectTarget(target: CollectionRunLedger["targets"][number]): Promise<CollectionTargetResult>;
}

export type RunControlDecision = "CONTINUE" | "PAUSE" | "CANCEL";

export interface RunControlContext {
  taskId: string;
  stage: "BEFORE_SEARCH" | "BEFORE_DETAIL" | "BEFORE_EXPORT";
  targetId: string;
  completedTargets: string[];
  failedTargets: TaskError[];
}

export interface RunControl {
  decide(context: RunControlContext): Promise<RunControlDecision>;
}

export interface ExportableRow {
  note: CanonicalNote;
  quality: QualityDecision;
}

export interface ExportHub {
  exportRows(task: TaskSpec, rows: ExportableRow[]): Promise<ExportReceipt[]>;
}
