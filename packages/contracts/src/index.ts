export const CONTRACT_VERSION = "1.0.0" as const;

export type TaskState =
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "NEEDS_HUMAN"
  | "FAILED"
  | "COMPLETED"
  | "CANCELLED";

export type ErrorCategory =
  | "RETRYABLE"
  | "NEEDS_HUMAN"
  | "PERMANENT"
  | "POLICY_BLOCKED";

export interface TaskSpec {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  projectId: string;
  goal: string;
  seedKeywords: string[];
  limits: {
    maxSearchResults: number;
    maxNoteDetails: number;
  };
  authorization: {
    readVisiblePages: boolean;
    externalApi: boolean;
    upload: boolean;
    publish: boolean;
  };
  createdAt: string;
}

export interface RawEnvelope {
  schemaVersion: typeof CONTRACT_VERSION;
  envelopeId: string;
  kind: "SEARCH_RESULTS" | "NOTE_DETAIL" | "COMMENT_PAGE";
  sourceUrl: string;
  collectedAt: string;
  parserVersion: string;
  payload: unknown;
  evidence: {
    fixturePath: string;
    sha256: string;
  };
}

export interface CanonicalAsset {
  assetId: string;
  type: "IMAGE" | "VIDEO" | "VIDEO_COVER";
  ordinal: number;
  sourceUrl: string;
  localPath: string | null;
  sha256: string | null;
  rightsStatus: "UNKNOWN" | "USER_OWNED" | "LICENSED" | "REFERENCE_ONLY";
}

export interface CanonicalNote {
  schemaVersion: typeof CONTRACT_VERSION;
  noteId: string;
  title: string;
  body: string | null;
  author: {
    authorId: string;
    displayName: string;
  };
  metrics: {
    likes: number | null;
    collects: number | null;
    comments: number | null;
    shares?: number | null;
    observedAt: string;
  };
  assets: CanonicalAsset[];
  expectedAssetCount: number | null;
  keywords: string[];
  detailStatus: "COMPLETE" | "INCOMPLETE";
  provenance: {
    sourceUrls: string[];
    envelopeIds: string[];
    parserVersions: string[];
    collectedAt: string[];
  };
}

export interface TaskError {
  targetId: string;
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
}

export interface Checkpoint {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  state: TaskState;
  completedTargets: string[];
  failedTargets: TaskError[];
  updatedAt: string;
}

export interface QualityIssue {
  code: string;
  severity: "WARN" | "BLOCK";
  field: string;
  message: string;
}

export interface QualityDecision {
  schemaVersion: typeof CONTRACT_VERSION;
  entityType: "NOTE" | "DATASET" | "EXPORT";
  entityId: string;
  decision: "PASS" | "WARN" | "BLOCK";
  issues: QualityIssue[];
  evaluatedAt: string;
  rulesVersion: string;
}

export interface ExportReceipt {
  schemaVersion: typeof CONTRACT_VERSION;
  exportId: string;
  taskId: string;
  format: "JSON" | "CSV";
  outputPath: string;
  rowCount: number;
  failedCount: number;
  sha256: string;
  fieldsVersion: string;
  createdAt: string;
}

export interface KeywordPolicy {
  maxDepth: number;
  maxKeywords: number;
  maxChildrenPerKeyword: number;
  noteDetailsPerKeyword: number;
  maxEstimatedNoteDetails: number;
  excludedTerms: string[];
}

export interface KeywordNode {
  keywordId: string;
  value: string;
  normalized: string;
  depth: number;
  source: "SEED" | "SUGGESTION";
  status: "QUEUED";
}

export interface KeywordEdge {
  parentKeywordId: string;
  childKeywordId: string;
  source: "SUGGESTION";
}

export interface KeywordPlan {
  schemaVersion: typeof CONTRACT_VERSION;
  planId: string;
  taskId: string;
  policy: KeywordPolicy;
  nodes: KeywordNode[];
  edges: KeywordEdge[];
  estimatedNoteDetails: number;
  truncation: {
    hitKeywordLimit: boolean;
    hitNoteBudget: boolean;
    prunedByDepth: number;
    prunedByExclusion: number;
    prunedByChildLimit: number;
  };
  createdAt: string;
}

export type RetryItemState = "QUEUED" | "IN_PROGRESS" | "RESOLVED" | "EXHAUSTED" | "BLOCKED";

export interface RetryQueueItem {
  targetId: string;
  state: RetryItemState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: TaskError;
}

export interface RetryQueueSnapshot {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  items: RetryQueueItem[];
  updatedAt: string;
}

export type RankingSnapshotCoverage = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface RankingSnapshotEntry {
  noteId: string;
  rank: number;
  sourceEnvelopeId: string;
}

export interface RankingSnapshot {
  schemaVersion: typeof CONTRACT_VERSION;
  snapshotId: string;
  scopeId: string;
  scopeLabel: string;
  coverage: RankingSnapshotCoverage;
  expectedSlots: number | null;
  entries: RankingSnapshotEntry[];
  observedAt: string;
}

export type RankingSignalKind =
  | "NEW_ENTRY"
  | "REENTERED"
  | "RISING"
  | "FALLING"
  | "UNCHANGED"
  | "DROPPED"
  | "NOT_OBSERVED";

export interface RankingSignal {
  noteId: string;
  kind: RankingSignalKind;
  previousRank: number | null;
  currentRank: number | null;
  rankDelta: number | null;
  consecutiveAppearances: number;
  firstSeenAt: string;
  lastSeenAt: string;
  priorityScore: number;
}

export interface RankingLedger {
  schemaVersion: typeof CONTRACT_VERSION;
  scopeId: string;
  snapshots: RankingSnapshot[];
  latestSignals: RankingSignal[];
  updatedAt: string;
}

export type CompletenessStatus =
  | "COMPLETE"
  | "PROVISIONAL"
  | "PARTIAL"
  | "INACCESSIBLE"
  | "DRIFTED"
  | "HUMAN_REQUIRED";

export interface ReplyThreadCompleteness {
  parentCommentId: string;
  declaredReplyCount: number | null;
  capturedReplyIds: string[];
  capturedReplyCount: number;
  expansionExhausted: boolean;
  missingReplyCount: number | null;
}

export interface NoteCompletenessLedger {
  schemaVersion: typeof CONTRACT_VERSION;
  noteId: string;
  detail: {
    status: CompletenessStatus;
    requiredFields: string[];
    presentFields: string[];
    missingFields: string[];
    evidenceEnvelopeIds: string[];
  };
  comments: {
    status: CompletenessStatus;
    platformDeclaredTotal: number | null;
    capturedTopLevelIds: string[];
    capturedReplyIds: string[];
    capturedTopLevelCount: number;
    capturedReplyCount: number;
    capturedUniqueCount: number;
    countGap: number | null;
    topLevelPaginationExhausted: boolean;
    unresolvedReplyThreads: number;
    replyThreads: ReplyThreadCompleteness[];
    nextCursor: string | null;
    evidenceEnvelopeIds: string[];
  };
  overallStatus: "COMPLETE" | "PROVISIONAL" | "PARTIAL" | "BLOCKED";
  observationCount: number;
  updatedAt: string;
}

export interface EnrichmentTask {
  targetId: string;
  noteId: string;
  priority: number;
  stages: Array<"DETAIL" | "COMMENTS">;
  reasons: string[];
  rankingSignal: RankingSignalKind;
  currentRank: number | null;
}

export interface BlockedEnrichmentTarget {
  noteId: string;
  reasons: string[];
  rankingSignal: RankingSignalKind;
}

export interface EnrichmentPlan {
  schemaVersion: typeof CONTRACT_VERSION;
  planId: string;
  scopeId: string;
  tasks: EnrichmentTask[];
  blockedTargets: BlockedEnrichmentTarget[];
  skippedDueToBudget: number;
  createdAt: string;
}

export type CollectionStage = "RANKING_SNAPSHOT" | "KEYWORD_SEARCH" | "DETAIL" | "COMMENTS";

export type CollectionTargetState =
  | "QUEUED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "SKIPPED";

export type CollectionRunStatus =
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "COMPLETED_WITH_BLOCKS"
  | "FAILED"
  | "CANCELLED";

export interface CollectionRunBudget {
  maxRankingSnapshots: number;
  maxKeywordSearches: number;
  maxDetailTargets: number;
  maxCommentTargets: number;
}

export interface CollectionRunTarget {
  targetId: string;
  stage: CollectionStage;
  state: CollectionTargetState;
  priority: number;
  keywordId: string | null;
  query: string | null;
  scopeId: string | null;
  noteId: string | null;
  attempts: number;
  evidenceEnvelopeIds: string[];
  lastError: TaskError | null;
  errorHistory: TaskError[];
  dispositionReason: string | null;
  updatedAt: string;
}

export interface CollectionRunLedger {
  schemaVersion: typeof CONTRACT_VERSION;
  runId: string;
  taskId: string;
  keywordPlanId: string;
  enrichmentPlanId: string;
  status: CollectionRunStatus;
  budget: CollectionRunBudget;
  targets: CollectionRunTarget[];
  recoveryCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ViralCandidateStatus = "ELIGIBLE" | "INSUFFICIENT_EVIDENCE" | "BLOCKED";

export interface MetricBaseline {
  median: number | null;
  sampleSize: number;
}

export interface ViralCandidateAssessment {
  schemaVersion: typeof CONTRACT_VERSION;
  assessmentId: string;
  scopeId: string;
  noteId: string;
  status: ViralCandidateStatus;
  score: number | null;
  formulaVersion: string;
  observationWindow: { startedAt: string; endedAt: string };
  sample: { totalNotes: number; eligibleNotes: number; minimumRequired: number; missingMetricRatio: number };
  rawMetrics: {
    likes: number | null;
    collects: number | null;
    comments: number | null;
    currentRank: number | null;
    rankDelta: number | null;
    consecutiveAppearances: number;
  };
  baseline: {
    method: "MEDIAN";
    likes: MetricBaseline;
    collects: MetricBaseline;
    comments: MetricBaseline;
  };
  scoreComponents: { ranking: number; engagement: number; persistence: number; evidence: number } | null;
  signals: string[];
  limitations: string[];
  evidenceEnvelopeIds: string[];
  counterexampleNoteIds: string[];
  assessedAt: string;
}

export type ContentDecisionStatus = "RESEARCH_READY" | "INSUFFICIENT_EVIDENCE" | "BLOCKED";

export interface ContentDecisionCard {
  schemaVersion: typeof CONTRACT_VERSION;
  cardId: string;
  assessmentId: string;
  noteId: string;
  status: ContentDecisionStatus;
  opportunitySummary: string;
  audienceQuestionHypothesis: string;
  angleHypothesis: string;
  openingHypotheses: string[];
  structureHypotheses: string[];
  materialRequirements: string[];
  differentiationChecks: string[];
  risks: string[];
  evidenceEnvelopeIds: string[];
  limitations: string[];
  requiresContentDirection: boolean;
  createdAt: string;
}

export type ContractName =
  | "TaskSpec"
  | "RawEnvelope"
  | "CanonicalNote"
  | "Checkpoint"
  | "QualityDecision"
  | "ExportReceipt"
  | "KeywordPlan"
  | "RetryQueueSnapshot"
  | "RankingSnapshot"
  | "RankingLedger"
  | "NoteCompletenessLedger"
  | "EnrichmentPlan"
  | "CollectionRunLedger"
  | "ViralCandidateAssessment"
  | "ContentDecisionCard";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0;

function requireVersion(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CONTRACT_VERSION) {
    errors.push(`schemaVersion must equal ${CONTRACT_VERSION}`);
  }
}

function validateTaskSpec(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["taskId", "projectId", "goal"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(value.seedKeywords) || value.seedKeywords.length < 1 || !value.seedKeywords.every(isNonEmptyString)) {
    errors.push("seedKeywords must contain at least one non-empty string");
  }
  if (!isRecord(value.limits)) {
    errors.push("limits must be an object");
  } else {
    const search = value.limits.maxSearchResults;
    const details = value.limits.maxNoteDetails;
    if (!Number.isInteger(search) || Number(search) < 1 || Number(search) > 20) {
      errors.push("limits.maxSearchResults must be an integer between 1 and 20");
    }
    if (!Number.isInteger(details) || Number(details) < 1 || Number(details) > 3) {
      errors.push("limits.maxNoteDetails must be an integer between 1 and 3");
    }
  }
  if (!isRecord(value.authorization)) {
    errors.push("authorization must be an object");
  } else {
    for (const key of ["readVisiblePages", "externalApi", "upload", "publish"] as const) {
      if (typeof value.authorization[key] !== "boolean") errors.push(`authorization.${key} must be boolean`);
    }
    if (value.authorization.readVisiblePages !== true) errors.push("authorization.readVisiblePages must be true");
  }
  if (!isTimestamp(value.createdAt)) errors.push("createdAt must be an ISO-compatible timestamp");
  return errors;
}

function validateRawEnvelope(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["envelopeId", "sourceUrl", "parserVersion"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (!["SEARCH_RESULTS", "NOTE_DETAIL", "COMMENT_PAGE"].includes(String(value.kind))) errors.push("kind is invalid");
  if (!isTimestamp(value.collectedAt)) errors.push("collectedAt must be an ISO-compatible timestamp");
  if (!isRecord(value.evidence)) errors.push("evidence must be an object");
  else {
    if (!isNonEmptyString(value.evidence.fixturePath)) errors.push("evidence.fixturePath is required");
    if (!isNonEmptyString(value.evidence.sha256) || !/^[a-f0-9]{64}$/i.test(value.evidence.sha256)) {
      errors.push("evidence.sha256 must be a 64-character hexadecimal hash");
    }
  }
  return errors;
}

function validateCanonicalNote(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["noteId", "title"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (value.body !== null && typeof value.body !== "string") errors.push("body must be a string or null");
  if (!isRecord(value.author) || !isNonEmptyString(value.author.authorId) || !isNonEmptyString(value.author.displayName)) {
    errors.push("author must contain authorId and displayName");
  }
  if (!isRecord(value.metrics) || !isTimestamp(value.metrics.observedAt)) errors.push("metrics.observedAt is required");
  if (!Array.isArray(value.assets)) errors.push("assets must be an array");
  if (!Array.isArray(value.keywords) || !value.keywords.every(isNonEmptyString)) errors.push("keywords must be an array of strings");
  if (value.detailStatus !== "COMPLETE" && value.detailStatus !== "INCOMPLETE") errors.push("detailStatus is invalid");
  if (!isRecord(value.provenance)) errors.push("provenance must be an object");
  return errors;
}

function validateCheckpoint(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!isNonEmptyString(value.taskId)) errors.push("taskId is required");
  const states: TaskState[] = ["DRAFT", "READY", "RUNNING", "PAUSED", "NEEDS_HUMAN", "FAILED", "COMPLETED", "CANCELLED"];
  if (!states.includes(value.state as TaskState)) errors.push("state is invalid");
  if (!Array.isArray(value.completedTargets) || !value.completedTargets.every(isNonEmptyString)) errors.push("completedTargets is invalid");
  if (!Array.isArray(value.failedTargets)) errors.push("failedTargets must be an array");
  if (!isTimestamp(value.updatedAt)) errors.push("updatedAt is required");
  return errors;
}

function validateQualityDecision(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!["NOTE", "DATASET", "EXPORT"].includes(String(value.entityType))) errors.push("entityType is invalid");
  if (!isNonEmptyString(value.entityId)) errors.push("entityId is required");
  if (!["PASS", "WARN", "BLOCK"].includes(String(value.decision))) errors.push("decision is invalid");
  if (!Array.isArray(value.issues)) errors.push("issues must be an array");
  if (!isTimestamp(value.evaluatedAt)) errors.push("evaluatedAt is required");
  if (!isNonEmptyString(value.rulesVersion)) errors.push("rulesVersion is required");
  return errors;
}

function validateExportReceipt(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["exportId", "taskId", "outputPath", "fieldsVersion"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  }
  if (value.format !== "JSON" && value.format !== "CSV") errors.push("format is invalid");
  if (!isNonNegativeInteger(value.rowCount)) errors.push("rowCount must be a non-negative integer");
  if (!isNonNegativeInteger(value.failedCount)) errors.push("failedCount must be a non-negative integer");
  if (!isNonEmptyString(value.sha256) || !/^[a-f0-9]{64}$/i.test(value.sha256)) errors.push("sha256 is invalid");
  if (!isTimestamp(value.createdAt)) errors.push("createdAt is required");
  return errors;
}

function validateTaskError(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return [`${prefix} must be an object`];
  const errors: string[] = [];
  if (!isNonEmptyString(value.targetId)) errors.push(`${prefix}.targetId is required`);
  if (!isNonEmptyString(value.code)) errors.push(`${prefix}.code is required`);
  if (!isNonEmptyString(value.message)) errors.push(`${prefix}.message is required`);
  if (!["RETRYABLE", "NEEDS_HUMAN", "PERMANENT", "POLICY_BLOCKED"].includes(String(value.category))) {
    errors.push(`${prefix}.category is invalid`);
  }
  if (typeof value.retryable !== "boolean") errors.push(`${prefix}.retryable must be boolean`);
  return errors;
}

function validateKeywordPlan(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!isNonEmptyString(value.planId)) errors.push("planId is required");
  if (!isNonEmptyString(value.taskId)) errors.push("taskId is required");
  if (!isRecord(value.policy)) {
    errors.push("policy must be an object");
  } else {
    const integerRanges: Array<[string, number, number]> = [
      ["maxDepth", 0, 5],
      ["maxKeywords", 1, 500],
      ["maxChildrenPerKeyword", 0, 50],
      ["noteDetailsPerKeyword", 1, 20],
      ["maxEstimatedNoteDetails", 1, 10_000],
    ];
    for (const [key, minimum, maximum] of integerRanges) {
      const candidate = value.policy[key];
      if (!Number.isInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
        errors.push(`policy.${key} must be an integer between ${minimum} and ${maximum}`);
      }
    }
    if (!Array.isArray(value.policy.excludedTerms) || !value.policy.excludedTerms.every(isNonEmptyString)) {
      errors.push("policy.excludedTerms must be an array of non-empty strings");
    }
  }
  if (!Array.isArray(value.nodes) || value.nodes.length < 1) {
    errors.push("nodes must contain at least one keyword");
  } else {
    const ids = new Set<string>();
    const normalized = new Set<string>();
    for (const [index, node] of value.nodes.entries()) {
      if (!isRecord(node)) {
        errors.push(`nodes[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(node.keywordId)) errors.push(`nodes[${index}].keywordId is required`);
      else if (ids.has(node.keywordId)) errors.push(`nodes[${index}].keywordId must be unique`);
      else ids.add(node.keywordId);
      if (!isNonEmptyString(node.value)) errors.push(`nodes[${index}].value is required`);
      if (!isNonEmptyString(node.normalized)) errors.push(`nodes[${index}].normalized is required`);
      else if (normalized.has(node.normalized)) errors.push(`nodes[${index}].normalized must be unique`);
      else normalized.add(node.normalized);
      if (!Number.isInteger(node.depth) || Number(node.depth) < 0) errors.push(`nodes[${index}].depth is invalid`);
      if (node.source !== "SEED" && node.source !== "SUGGESTION") errors.push(`nodes[${index}].source is invalid`);
      if (node.status !== "QUEUED") errors.push(`nodes[${index}].status is invalid`);
    }
  }
  if (!Array.isArray(value.edges)) errors.push("edges must be an array");
  if (!isNonNegativeInteger(value.estimatedNoteDetails)) errors.push("estimatedNoteDetails must be a non-negative integer");
  if (!isRecord(value.truncation)) errors.push("truncation must be an object");
  else {
    for (const key of ["hitKeywordLimit", "hitNoteBudget"] as const) {
      if (typeof value.truncation[key] !== "boolean") errors.push(`truncation.${key} must be boolean`);
    }
    for (const key of ["prunedByDepth", "prunedByExclusion", "prunedByChildLimit"] as const) {
      if (!isNonNegativeInteger(value.truncation[key])) errors.push(`truncation.${key} must be a non-negative integer`);
    }
  }
  if (!isTimestamp(value.createdAt)) errors.push("createdAt is required");
  return errors;
}

function validateRetryQueueSnapshot(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!isNonEmptyString(value.taskId)) errors.push("taskId is required");
  if (!Array.isArray(value.items)) {
    errors.push("items must be an array");
  } else {
    const targets = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (!isRecord(item)) {
        errors.push(`items[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(item.targetId)) errors.push(`items[${index}].targetId is required`);
      else if (targets.has(item.targetId)) errors.push(`items[${index}].targetId must be unique`);
      else targets.add(item.targetId);
      if (!["QUEUED", "IN_PROGRESS", "RESOLVED", "EXHAUSTED", "BLOCKED"].includes(String(item.state))) {
        errors.push(`items[${index}].state is invalid`);
      }
      if (!isNonNegativeInteger(item.attempts)) errors.push(`items[${index}].attempts must be non-negative`);
      if (!Number.isInteger(item.maxAttempts) || Number(item.maxAttempts) < 1 || Number(item.maxAttempts) > 10) {
        errors.push(`items[${index}].maxAttempts must be an integer between 1 and 10`);
      }
      if (item.nextAttemptAt !== null && !isTimestamp(item.nextAttemptAt)) {
        errors.push(`items[${index}].nextAttemptAt must be a timestamp or null`);
      }
      errors.push(...validateTaskError(item.lastError, `items[${index}].lastError`));
    }
  }
  if (!isTimestamp(value.updatedAt)) errors.push("updatedAt is required");
  return errors;
}

const rankingSignalKinds: RankingSignalKind[] = [
  "NEW_ENTRY",
  "REENTERED",
  "RISING",
  "FALLING",
  "UNCHANGED",
  "DROPPED",
  "NOT_OBSERVED",
];

const completenessStatuses: CompletenessStatus[] = [
  "COMPLETE",
  "PROVISIONAL",
  "PARTIAL",
  "INACCESSIBLE",
  "DRIFTED",
  "HUMAN_REQUIRED",
];

function validateRankingSnapshot(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["snapshotId", "scopeId", "scopeLabel"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  }
  if (!["COMPLETE", "PARTIAL", "UNKNOWN"].includes(String(value.coverage))) {
    errors.push("coverage is invalid");
  }
  if (value.expectedSlots !== null && !isNonNegativeInteger(value.expectedSlots)) {
    errors.push("expectedSlots must be a non-negative integer or null");
  }
  if (!Array.isArray(value.entries)) {
    errors.push("entries must be an array");
  } else {
    const noteIds = new Set<string>();
    const ranks = new Set<number>();
    for (const [index, entry] of value.entries.entries()) {
      if (!isRecord(entry)) {
        errors.push(`entries[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(entry.noteId)) errors.push(`entries[${index}].noteId is required`);
      else if (noteIds.has(entry.noteId)) errors.push(`entries[${index}].noteId must be unique`);
      else noteIds.add(entry.noteId);
      if (!Number.isInteger(entry.rank) || Number(entry.rank) < 1) {
        errors.push(`entries[${index}].rank must be a positive integer`);
      } else if (ranks.has(Number(entry.rank))) errors.push(`entries[${index}].rank must be unique`);
      else ranks.add(Number(entry.rank));
      if (!isNonEmptyString(entry.sourceEnvelopeId)) errors.push(`entries[${index}].sourceEnvelopeId is required`);
    }
    if (value.coverage === "COMPLETE") {
      if (value.expectedSlots === null) errors.push("COMPLETE coverage requires expectedSlots");
      else if (Number(value.expectedSlots) !== value.entries.length) {
        errors.push("COMPLETE coverage requires entries.length to equal expectedSlots");
      } else {
        const expectedRanks = Array.from({ length: Number(value.expectedSlots) }, (_, index) => index + 1);
        const actualRanks = [...ranks].sort((a, b) => a - b);
        if (JSON.stringify(actualRanks) !== JSON.stringify(expectedRanks)) {
          errors.push("COMPLETE coverage requires contiguous ranks from 1 through expectedSlots");
        }
      }
    }
  }
  if (!isTimestamp(value.observedAt)) errors.push("observedAt is required");
  return errors;
}

function validateRankingSignal(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return [`${prefix} must be an object`];
  const errors: string[] = [];
  if (!isNonEmptyString(value.noteId)) errors.push(`${prefix}.noteId is required`);
  if (!rankingSignalKinds.includes(value.kind as RankingSignalKind)) errors.push(`${prefix}.kind is invalid`);
  for (const key of ["previousRank", "currentRank"] as const) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || Number(value[key]) < 1)) {
      errors.push(`${prefix}.${key} must be a positive integer or null`);
    }
  }
  if (value.rankDelta !== null && !Number.isInteger(value.rankDelta)) errors.push(`${prefix}.rankDelta is invalid`);
  if (!Number.isInteger(value.consecutiveAppearances) || Number(value.consecutiveAppearances) < 0) {
    errors.push(`${prefix}.consecutiveAppearances must be non-negative`);
  }
  if (!isTimestamp(value.firstSeenAt) || !isTimestamp(value.lastSeenAt)) errors.push(`${prefix} timestamps are invalid`);
  if (typeof value.priorityScore !== "number" || value.priorityScore < 0 || value.priorityScore > 100) {
    errors.push(`${prefix}.priorityScore must be between 0 and 100`);
  }
  return errors;
}

function validateRankingLedger(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!isNonEmptyString(value.scopeId)) errors.push("scopeId is required");
  if (!Array.isArray(value.snapshots) || value.snapshots.length < 1) {
    errors.push("snapshots must contain at least one snapshot");
  } else {
    const snapshotIds = new Set<string>();
    for (const [index, snapshot] of value.snapshots.entries()) {
      if (!isRecord(snapshot)) {
        errors.push(`snapshots[${index}] must be an object`);
        continue;
      }
      errors.push(...validateRankingSnapshot(snapshot).map((error) => `snapshots[${index}].${error}`));
      if (snapshot.scopeId !== value.scopeId) errors.push(`snapshots[${index}].scopeId must match ledger scopeId`);
      if (isNonEmptyString(snapshot.snapshotId)) {
        if (snapshotIds.has(snapshot.snapshotId)) errors.push(`snapshots[${index}].snapshotId must be unique`);
        snapshotIds.add(snapshot.snapshotId);
      }
    }
  }
  if (!Array.isArray(value.latestSignals)) errors.push("latestSignals must be an array");
  else {
    const noteIds = new Set<string>();
    for (const [index, signal] of value.latestSignals.entries()) {
      errors.push(...validateRankingSignal(signal, `latestSignals[${index}]`));
      if (isRecord(signal) && isNonEmptyString(signal.noteId)) {
        if (noteIds.has(signal.noteId)) errors.push(`latestSignals[${index}].noteId must be unique`);
        noteIds.add(signal.noteId);
      }
    }
  }
  if (!isTimestamp(value.updatedAt)) errors.push("updatedAt is required");
  return errors;
}

function validateNoteCompletenessLedger(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  if (!isNonEmptyString(value.noteId)) errors.push("noteId is required");
  if (!isRecord(value.detail)) errors.push("detail must be an object");
  else {
    if (!completenessStatuses.includes(value.detail.status as CompletenessStatus)) errors.push("detail.status is invalid");
    for (const key of ["requiredFields", "presentFields", "missingFields", "evidenceEnvelopeIds"] as const) {
      if (!Array.isArray(value.detail[key]) || !value.detail[key].every(isNonEmptyString)) errors.push(`detail.${key} is invalid`);
    }
    if (value.detail.status === "COMPLETE" && Array.isArray(value.detail.missingFields) && value.detail.missingFields.length > 0) {
      errors.push("detail COMPLETE requires no missing fields");
    }
  }
  if (!isRecord(value.comments)) errors.push("comments must be an object");
  else {
    if (!completenessStatuses.includes(value.comments.status as CompletenessStatus)) errors.push("comments.status is invalid");
    for (const key of ["platformDeclaredTotal", "countGap"] as const) {
      if (value.comments[key] !== null && !isNonNegativeInteger(value.comments[key])) {
        errors.push(`comments.${key} must be non-negative or null`);
      }
    }
    for (const key of ["capturedTopLevelCount", "capturedReplyCount", "capturedUniqueCount", "unresolvedReplyThreads"] as const) {
      if (!isNonNegativeInteger(value.comments[key])) errors.push(`comments.${key} must be non-negative`);
    }
    if (typeof value.comments.topLevelPaginationExhausted !== "boolean") {
      errors.push("comments.topLevelPaginationExhausted must be boolean");
    }
    if (value.comments.nextCursor !== null && !isNonEmptyString(value.comments.nextCursor)) {
      errors.push("comments.nextCursor must be a string or null");
    }
    if (!Array.isArray(value.comments.evidenceEnvelopeIds) || !value.comments.evidenceEnvelopeIds.every(isNonEmptyString)) {
      errors.push("comments.evidenceEnvelopeIds is invalid");
    }
    for (const key of ["capturedTopLevelIds", "capturedReplyIds"] as const) {
      if (!Array.isArray(value.comments[key]) || !value.comments[key].every(isNonEmptyString)) {
        errors.push(`comments.${key} is invalid`);
      }
    }
    if (Array.isArray(value.comments.capturedTopLevelIds) && new Set(value.comments.capturedTopLevelIds).size !== value.comments.capturedTopLevelIds.length) {
      errors.push("comments.capturedTopLevelIds must be unique");
    }
    if (Array.isArray(value.comments.capturedReplyIds) && new Set(value.comments.capturedReplyIds).size !== value.comments.capturedReplyIds.length) {
      errors.push("comments.capturedReplyIds must be unique");
    }
    if (Array.isArray(value.comments.capturedTopLevelIds) && value.comments.capturedTopLevelCount !== value.comments.capturedTopLevelIds.length) {
      errors.push("comments.capturedTopLevelCount must equal capturedTopLevelIds.length");
    }
    if (Array.isArray(value.comments.capturedReplyIds) && value.comments.capturedReplyCount !== value.comments.capturedReplyIds.length) {
      errors.push("comments.capturedReplyCount must equal capturedReplyIds.length");
    }
    if (Array.isArray(value.comments.capturedTopLevelIds) && Array.isArray(value.comments.capturedReplyIds)) {
      const uniqueCaptured = new Set([...value.comments.capturedTopLevelIds, ...value.comments.capturedReplyIds]).size;
      if (value.comments.capturedUniqueCount !== uniqueCaptured) {
        errors.push("comments.capturedUniqueCount must equal unique captured comment and reply IDs");
      }
    }
    if (!Array.isArray(value.comments.replyThreads)) errors.push("comments.replyThreads must be an array");
    else {
      for (const [index, thread] of value.comments.replyThreads.entries()) {
        if (!isRecord(thread)) {
          errors.push(`comments.replyThreads[${index}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(thread.parentCommentId)) errors.push(`comments.replyThreads[${index}].parentCommentId is required`);
        if (!Array.isArray(thread.capturedReplyIds) || !thread.capturedReplyIds.every(isNonEmptyString)) {
          errors.push(`comments.replyThreads[${index}].capturedReplyIds is invalid`);
        } else if (thread.capturedReplyCount !== new Set(thread.capturedReplyIds).size) {
          errors.push(`comments.replyThreads[${index}].capturedReplyCount must equal unique capturedReplyIds`);
        }
        if (thread.declaredReplyCount !== null && !isNonNegativeInteger(thread.declaredReplyCount)) {
          errors.push(`comments.replyThreads[${index}].declaredReplyCount is invalid`);
        }
        if (!isNonNegativeInteger(thread.capturedReplyCount)) errors.push(`comments.replyThreads[${index}].capturedReplyCount is invalid`);
        if (typeof thread.expansionExhausted !== "boolean") errors.push(`comments.replyThreads[${index}].expansionExhausted is invalid`);
        if (thread.missingReplyCount !== null && !isNonNegativeInteger(thread.missingReplyCount)) {
          errors.push(`comments.replyThreads[${index}].missingReplyCount is invalid`);
        }
      }
    }
    if (value.comments.status === "COMPLETE") {
      if (value.comments.platformDeclaredTotal === null) errors.push("comments COMPLETE requires platformDeclaredTotal");
      if (value.comments.countGap !== 0) errors.push("comments COMPLETE requires countGap 0");
      if (value.comments.topLevelPaginationExhausted !== true) errors.push("comments COMPLETE requires exhausted top-level pagination");
      if (value.comments.unresolvedReplyThreads !== 0) errors.push("comments COMPLETE requires no unresolved reply threads");
      if (value.comments.nextCursor !== null) errors.push("comments COMPLETE requires no next cursor");
    }
  }
  if (!["COMPLETE", "PROVISIONAL", "PARTIAL", "BLOCKED"].includes(String(value.overallStatus))) {
    errors.push("overallStatus is invalid");
  }
  if (!Number.isInteger(value.observationCount) || Number(value.observationCount) < 1) {
    errors.push("observationCount must be a positive integer");
  }
  if (!isTimestamp(value.updatedAt)) errors.push("updatedAt is required");
  return errors;
}

function validateEnrichmentPlan(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  const automaticNoteIds = new Set<string>();
  if (!isNonEmptyString(value.planId)) errors.push("planId is required");
  if (!isNonEmptyString(value.scopeId)) errors.push("scopeId is required");
  if (!Array.isArray(value.tasks)) errors.push("tasks must be an array");
  else {
    for (const [index, task] of value.tasks.entries()) {
      if (!isRecord(task)) {
        errors.push(`tasks[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(task.targetId)) errors.push(`tasks[${index}].targetId is required`);
      if (!isNonEmptyString(task.noteId)) errors.push(`tasks[${index}].noteId is required`);
      else if (automaticNoteIds.has(task.noteId)) errors.push(`tasks[${index}].noteId must be unique`);
      else automaticNoteIds.add(task.noteId);
      if (typeof task.priority !== "number" || task.priority < 0 || task.priority > 100) {
        errors.push(`tasks[${index}].priority must be between 0 and 100`);
      }
      if (!Array.isArray(task.stages) || task.stages.length < 1 || !task.stages.every((stage) => stage === "DETAIL" || stage === "COMMENTS")) {
        errors.push(`tasks[${index}].stages is invalid`);
      }
      if (!Array.isArray(task.reasons) || task.reasons.length < 1 || !task.reasons.every(isNonEmptyString)) {
        errors.push(`tasks[${index}].reasons is invalid`);
      }
      if (!rankingSignalKinds.includes(task.rankingSignal as RankingSignalKind)) errors.push(`tasks[${index}].rankingSignal is invalid`);
      if (task.currentRank !== null && (!Number.isInteger(task.currentRank) || Number(task.currentRank) < 1)) {
        errors.push(`tasks[${index}].currentRank is invalid`);
      }
    }
  }
  if (!Array.isArray(value.blockedTargets)) errors.push("blockedTargets must be an array");
  else {
    const blockedNoteIds = new Set<string>();
    for (const [index, target] of value.blockedTargets.entries()) {
      if (!isRecord(target)) {
        errors.push(`blockedTargets[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(target.noteId)) errors.push(`blockedTargets[${index}].noteId is required`);
      else if (blockedNoteIds.has(target.noteId)) errors.push(`blockedTargets[${index}].noteId must be unique`);
      else {
        blockedNoteIds.add(target.noteId);
        if (automaticNoteIds.has(target.noteId)) errors.push(`blockedTargets[${index}].noteId cannot also be an automatic task`);
      }
      if (!Array.isArray(target.reasons) || target.reasons.length < 1 || !target.reasons.every(isNonEmptyString)) {
        errors.push(`blockedTargets[${index}].reasons is invalid`);
      }
      if (!rankingSignalKinds.includes(target.rankingSignal as RankingSignalKind)) {
        errors.push(`blockedTargets[${index}].rankingSignal is invalid`);
      }
    }
  }
  if (!isNonNegativeInteger(value.skippedDueToBudget)) errors.push("skippedDueToBudget must be non-negative");
  if (!isTimestamp(value.createdAt)) errors.push("createdAt is required");
  return errors;
}

const collectionStages: CollectionStage[] = ["RANKING_SNAPSHOT", "KEYWORD_SEARCH", "DETAIL", "COMMENTS"];
const collectionTargetStates: CollectionTargetState[] = ["QUEUED", "IN_PROGRESS", "COMPLETED", "BLOCKED", "FAILED", "SKIPPED"];
const collectionRunStatuses: CollectionRunStatus[] = [
  "READY",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "COMPLETED_WITH_BLOCKS",
  "FAILED",
  "CANCELLED",
];

function validateCollectionRunLedger(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["runId", "taskId", "keywordPlanId", "enrichmentPlanId"] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  }
  if (!collectionRunStatuses.includes(value.status as CollectionRunStatus)) errors.push("status is invalid");
  if (!isRecord(value.budget)) errors.push("budget must be an object");
  else {
    for (const key of ["maxRankingSnapshots", "maxKeywordSearches", "maxDetailTargets", "maxCommentTargets"] as const) {
      if (!isNonNegativeInteger(value.budget[key]) || Number(value.budget[key]) > 10_000) {
        errors.push(`budget.${key} must be an integer between 0 and 10000`);
      }
    }
  }
  if (!Array.isArray(value.targets)) errors.push("targets must be an array");
  else {
    const targetIds = new Set<string>();
    for (const [index, target] of value.targets.entries()) {
      const prefix = `targets[${index}]`;
      if (!isRecord(target)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!isNonEmptyString(target.targetId)) errors.push(`${prefix}.targetId is required`);
      else if (targetIds.has(target.targetId)) errors.push(`${prefix}.targetId must be unique`);
      else targetIds.add(target.targetId);
      if (!collectionStages.includes(target.stage as CollectionStage)) errors.push(`${prefix}.stage is invalid`);
      if (!collectionTargetStates.includes(target.state as CollectionTargetState)) errors.push(`${prefix}.state is invalid`);
      if (typeof target.priority !== "number" || target.priority < 0 || target.priority > 100) {
        errors.push(`${prefix}.priority must be between 0 and 100`);
      }
      for (const key of ["keywordId", "query", "scopeId", "noteId"] as const) {
        if (target[key] !== null && !isNonEmptyString(target[key])) errors.push(`${prefix}.${key} must be a string or null`);
      }
      if (target.stage === "RANKING_SNAPSHOT" && !isNonEmptyString(target.scopeId)) {
        errors.push(`${prefix}.scopeId is required for ranking snapshots`);
      }
      if (target.stage === "KEYWORD_SEARCH" && !isNonEmptyString(target.keywordId)) {
        errors.push(`${prefix}.keywordId is required for keyword searches`);
      }
      if (target.stage === "KEYWORD_SEARCH" && !isNonEmptyString(target.query)) {
        errors.push(`${prefix}.query is required for keyword searches`);
      }
      if ((target.stage === "DETAIL" || target.stage === "COMMENTS") && !isNonEmptyString(target.noteId)) {
        errors.push(`${prefix}.noteId is required for detail and comment targets`);
      }
      if (!isNonNegativeInteger(target.attempts)) errors.push(`${prefix}.attempts must be non-negative`);
      if (!Array.isArray(target.evidenceEnvelopeIds) || !target.evidenceEnvelopeIds.every(isNonEmptyString)) {
        errors.push(`${prefix}.evidenceEnvelopeIds is invalid`);
      } else if (new Set(target.evidenceEnvelopeIds).size !== target.evidenceEnvelopeIds.length) {
        errors.push(`${prefix}.evidenceEnvelopeIds must be unique`);
      }
      if (target.lastError !== null) errors.push(...validateTaskError(target.lastError, `${prefix}.lastError`));
      if (!Array.isArray(target.errorHistory)) errors.push(`${prefix}.errorHistory must be an array`);
      else target.errorHistory.forEach((error, errorIndex) => {
        errors.push(...validateTaskError(error, `${prefix}.errorHistory[${errorIndex}]`));
      });
      if (target.dispositionReason !== null && !isNonEmptyString(target.dispositionReason)) {
        errors.push(`${prefix}.dispositionReason must be a string or null`);
      }
      if (!isTimestamp(target.updatedAt)) errors.push(`${prefix}.updatedAt is required`);
      if (target.state === "IN_PROGRESS" && Number(target.attempts) < 1) {
        errors.push(`${prefix}.IN_PROGRESS requires at least one attempt`);
      }
      if (target.state === "COMPLETED") {
        if (!Array.isArray(target.evidenceEnvelopeIds) || target.evidenceEnvelopeIds.length < 1) {
          errors.push(`${prefix}.COMPLETED requires evidence`);
        }
        if (target.lastError !== null) errors.push(`${prefix}.COMPLETED cannot retain lastError`);
      }
      if ((target.state === "BLOCKED" || target.state === "FAILED") && target.lastError === null) {
        errors.push(`${prefix}.${target.state} requires lastError`);
      }
      if (target.state === "SKIPPED" && !isNonEmptyString(target.dispositionReason)) {
        errors.push(`${prefix}.SKIPPED requires dispositionReason`);
      }
    }
  }
  if (!isNonNegativeInteger(value.recoveryCount)) errors.push("recoveryCount must be non-negative");
  if (!isTimestamp(value.createdAt)) errors.push("createdAt is required");
  if (!isTimestamp(value.updatedAt)) errors.push("updatedAt is required");
  return errors;
}

function validateMetricBaseline(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return [`${prefix} must be an object`];
  const errors: string[] = [];
  if (value.median !== null && (typeof value.median !== "number" || value.median < 0)) errors.push(`${prefix}.median must be a non-negative number or null`);
  if (!isNonNegativeInteger(value.sampleSize)) errors.push(`${prefix}.sampleSize must be non-negative`);
  return errors;
}

function validateStringArray(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return [`${prefix} must be an array of non-empty strings`];
  if (new Set(value).size !== value.length) return [`${prefix} must contain unique values`];
  return [];
}

function validateViralCandidateAssessment(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["assessmentId", "scopeId", "noteId", "formulaVersion"] as const) if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!["ELIGIBLE", "INSUFFICIENT_EVIDENCE", "BLOCKED"].includes(String(value.status))) errors.push("status is invalid");
  if (value.score !== null && (typeof value.score !== "number" || value.score < 0 || value.score > 100)) errors.push("score must be between 0 and 100 or null");
  if (value.status !== "ELIGIBLE" && value.score !== null) errors.push("non-eligible assessments cannot have a score");
  if (value.status === "ELIGIBLE" && value.score === null) errors.push("eligible assessments require a score");
  if (!isRecord(value.observationWindow) || !isTimestamp(value.observationWindow.startedAt) || !isTimestamp(value.observationWindow.endedAt)) errors.push("observationWindow requires valid timestamps");
  if (!isRecord(value.sample)) errors.push("sample must be an object");
  else {
    for (const key of ["totalNotes", "eligibleNotes", "minimumRequired"] as const) if (!isNonNegativeInteger(value.sample[key])) errors.push(`sample.${key} must be non-negative`);
    if (typeof value.sample.missingMetricRatio !== "number" || value.sample.missingMetricRatio < 0 || value.sample.missingMetricRatio > 1) errors.push("sample.missingMetricRatio must be between 0 and 1");
  }
  if (!isRecord(value.rawMetrics)) errors.push("rawMetrics must be an object");
  else {
    for (const key of ["likes", "collects", "comments", "currentRank", "rankDelta"] as const) if (value.rawMetrics[key] !== null && typeof value.rawMetrics[key] !== "number") errors.push(`rawMetrics.${key} must be a number or null`);
    if (!isNonNegativeInteger(value.rawMetrics.consecutiveAppearances)) errors.push("rawMetrics.consecutiveAppearances must be non-negative");
  }
  if (!isRecord(value.baseline) || value.baseline.method !== "MEDIAN") errors.push("baseline.method must be MEDIAN");
  else for (const key of ["likes", "collects", "comments"] as const) errors.push(...validateMetricBaseline(value.baseline[key], `baseline.${key}`));
  if (value.scoreComponents !== null) {
    if (!isRecord(value.scoreComponents)) errors.push("scoreComponents must be an object or null");
    else for (const key of ["ranking", "engagement", "persistence", "evidence"] as const) {
      const component = value.scoreComponents[key];
      if (typeof component !== "number" || component < 0 || component > 100) errors.push(`scoreComponents.${key} must be between 0 and 100`);
    }
  }
  for (const key of ["signals", "limitations", "evidenceEnvelopeIds", "counterexampleNoteIds"] as const) errors.push(...validateStringArray(value[key], key));
  if (!isTimestamp(value.assessedAt)) errors.push("assessedAt is required");
  return errors;
}

function validateContentDecisionCard(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  requireVersion(value, errors);
  for (const key of ["cardId", "assessmentId", "noteId", "opportunitySummary", "audienceQuestionHypothesis", "angleHypothesis"] as const) if (!isNonEmptyString(value[key])) errors.push(`${key} is required`);
  if (!["RESEARCH_READY", "INSUFFICIENT_EVIDENCE", "BLOCKED"].includes(String(value.status))) errors.push("status is invalid");
  for (const key of ["openingHypotheses", "structureHypotheses", "materialRequirements", "differentiationChecks", "risks", "evidenceEnvelopeIds", "limitations"] as const) errors.push(...validateStringArray(value[key], key));
  if (typeof value.requiresContentDirection !== "boolean") errors.push("requiresContentDirection must be boolean");
  if (!isTimestamp(value.createdAt)) errors.push("createdAt is required");
  return errors;
}

export function validateContract(name: ContractName, value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, errors: [`${name} must be an object`] };
  const validators: Record<ContractName, (input: Record<string, unknown>) => string[]> = {
    TaskSpec: validateTaskSpec,
    RawEnvelope: validateRawEnvelope,
    CanonicalNote: validateCanonicalNote,
    Checkpoint: validateCheckpoint,
    QualityDecision: validateQualityDecision,
    ExportReceipt: validateExportReceipt,
    KeywordPlan: validateKeywordPlan,
    RetryQueueSnapshot: validateRetryQueueSnapshot,
    RankingSnapshot: validateRankingSnapshot,
    RankingLedger: validateRankingLedger,
    NoteCompletenessLedger: validateNoteCompletenessLedger,
    EnrichmentPlan: validateEnrichmentPlan,
    CollectionRunLedger: validateCollectionRunLedger,
    ViralCandidateAssessment: validateViralCandidateAssessment,
    ContentDecisionCard: validateContentDecisionCard,
  };
  const errors = validators[name](value);
  return { ok: errors.length === 0, errors };
}

export class ContractValidationError extends Error {
  readonly contract: ContractName;
  readonly errors: string[];

  constructor(contract: ContractName, errors: string[]) {
    super(`${contract} validation failed: ${errors.join("; ")}`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.errors = errors;
  }
}

export function assertContract<T>(name: ContractName, value: unknown): asserts value is T {
  const result = validateContract(name, value);
  if (!result.ok) throw new ContractValidationError(name, result.errors);
}
