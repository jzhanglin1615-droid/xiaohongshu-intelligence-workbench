import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalNote,
  Checkpoint,
  CollectionRunLedger,
  ContentDecisionCard,
  EnrichmentPlan,
  NoteCompletenessLedger,
  QualityDecision,
  RankingLedger,
  RawEnvelope,
  RetryQueueSnapshot,
  ViralCandidateAssessment,
} from "../../contracts/src/index.ts";
import { SqliteEvidenceStore, type SavedView, type StoreIntegrityReport } from "./sqlite-store.ts";

export interface LegacyEvidenceDocument {
  storeVersion?: string;
  rawEnvelopes?: RawEnvelope[];
  notes?: CanonicalNote[];
  qualityDecisions?: QualityDecision[];
  checkpoints?: Checkpoint[];
  retryQueues?: RetryQueueSnapshot[];
  rankingLedgers?: RankingLedger[];
  completenessLedgers?: NoteCompletenessLedger[];
  enrichmentPlans?: EnrichmentPlan[];
  collectionRunLedgers?: CollectionRunLedger[];
  viralAssessments?: ViralCandidateAssessment[];
  contentDecisionCards?: ContentDecisionCard[];
  savedViews?: SavedView[];
}

export interface DatabaseMaintenanceReceipt {
  receiptId: string;
  operation: "LEGACY_JSON_MIGRATION" | "SQLITE_RESTORE";
  status: "SUCCEEDED";
  occurredAt: string;
  sourcePath: string;
  destinationPath: string;
  sourceSha256: string;
  sourceBytes: number;
  backupPath: string | null;
  integrity: StoreIntegrityReport;
  counts?: Record<string, number>;
}

const exists = async (filePath: string): Promise<boolean> => stat(filePath).then(() => true, () => false);
const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
const arrays = ["rawEnvelopes", "notes", "qualityDecisions", "checkpoints", "retryQueues", "rankingLedgers", "completenessLedgers", "enrichmentPlans", "collectionRunLedgers", "viralAssessments", "contentDecisionCards", "savedViews"] as const;

export function validateLegacyEvidenceDocument(value: unknown): LegacyEvidenceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LEGACY_DATABASE_OBJECT_REQUIRED");
  const document = value as Record<string, unknown>;
  if (!arrays.some((key) => Array.isArray(document[key]))) throw new Error("LEGACY_DATABASE_COLLECTIONS_REQUIRED");
  for (const key of arrays) if (document[key] !== undefined && !Array.isArray(document[key])) throw new Error(`LEGACY_DATABASE_${key.toUpperCase()}_MUST_BE_ARRAY`);
  return document as LegacyEvidenceDocument;
}

export async function importLegacyEvidenceDocument(store: SqliteEvidenceStore, input: unknown): Promise<Record<string, number>> {
  const document = validateLegacyEvidenceDocument(input);
  await store.saveRawEnvelopes(document.rawEnvelopes ?? []);
  await store.upsertNotes(document.notes ?? []);
  await store.saveQuality(document.qualityDecisions ?? []);
  for (const item of document.checkpoints ?? []) await store.saveCheckpoint(item);
  for (const item of document.retryQueues ?? []) await store.saveRetryQueue(item);
  for (const item of document.rankingLedgers ?? []) await store.saveRankingLedger(item);
  for (const item of document.completenessLedgers ?? []) await store.saveCompletenessLedger(item);
  for (const item of document.enrichmentPlans ?? []) await store.saveEnrichmentPlan(item);
  for (const item of document.collectionRunLedgers ?? []) await store.saveCollectionRunLedger(item);
  await store.saveViralAssessments(document.viralAssessments ?? []);
  await store.saveContentDecisionCards(document.contentDecisionCards ?? []);
  for (const item of document.savedViews ?? []) await store.saveView(item);
  return Object.fromEntries(arrays.map((key) => [key, document[key]?.length ?? 0]));
}

export async function migrateLegacyJsonDatabase(options: { legacyPath: string; sqlitePath: string; receiptPath?: string; occurredAt?: string }): Promise<DatabaseMaintenanceReceipt | null> {
  const legacyPath = path.resolve(options.legacyPath);
  const sqlitePath = path.resolve(options.sqlitePath);
  if (await exists(sqlitePath) || !(await exists(legacyPath))) return null;
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const source = await readFile(legacyPath);
  const stagingPath = `${sqlitePath}.migration-${randomUUID()}.tmp`;
  await mkdir(path.dirname(sqlitePath), { recursive: true });
  let store: SqliteEvidenceStore | null = null;
  try {
    store = new SqliteEvidenceStore(stagingPath);
    const counts = await importLegacyEvidenceDocument(store, JSON.parse(source.toString("utf8")));
    const integrity = store.integrity();
    if (integrity.status !== "OK") throw new Error("MIGRATED_DATABASE_INTEGRITY_FAILED");
    store.close(); store = null;
    await rename(stagingPath, sqlitePath);
    const receipt: DatabaseMaintenanceReceipt = { receiptId: `migration-${randomUUID()}`, operation: "LEGACY_JSON_MIGRATION", status: "SUCCEEDED", occurredAt, sourcePath: legacyPath, destinationPath: sqlitePath, sourceSha256: sha256(source), sourceBytes: source.byteLength, backupPath: null, integrity, counts };
    if (options.receiptPath) { await mkdir(path.dirname(path.resolve(options.receiptPath)), { recursive: true }); await writeFile(path.resolve(options.receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8"); }
    return receipt;
  } finally {
    store?.close();
    if (await exists(stagingPath)) await rm(stagingPath, { force: true });
  }
}

export async function restoreSqliteDatabase(options: { activePath: string; candidatePath: string; backupDirectory: string; occurredAt?: string }): Promise<DatabaseMaintenanceReceipt> {
  const activePath = path.resolve(options.activePath);
  const candidatePath = path.resolve(options.candidatePath);
  if (activePath === candidatePath) throw new Error("RESTORE_CANDIDATE_MUST_DIFFER");
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const candidateBytes = await readFile(candidatePath);
  if (candidateBytes.byteLength < 16 || candidateBytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("RESTORE_CANDIDATE_NOT_SQLITE");
  const token = randomUUID();
  const normalizedPath = `${activePath}.restore-${token}.tmp`;
  const rollbackPath = `${activePath}.rollback-${token}.tmp`;
  const backupPath = path.join(path.resolve(options.backupDirectory), `pre-restore-${occurredAt.replace(/[:.]/g, "-")}-${token}.sqlite`);
  await mkdir(path.dirname(activePath), { recursive: true });
  await mkdir(path.dirname(backupPath), { recursive: true });
  let candidate: SqliteEvidenceStore | null = null;
  let current: SqliteEvidenceStore | null = null;
  let replacementInstalled = false;
  try {
    candidate = new SqliteEvidenceStore(candidatePath);
    const candidateIntegrity = candidate.integrity();
    if (candidateIntegrity.status !== "OK") throw new Error("RESTORE_CANDIDATE_INTEGRITY_FAILED");
    await candidate.backup(normalizedPath);
    candidate.close(); candidate = null;

    if (await exists(activePath)) {
      current = new SqliteEvidenceStore(activePath);
      const currentIntegrity = await current.backup(backupPath);
      if (currentIntegrity.status !== "OK") throw new Error("RESTORE_PRE_BACKUP_INTEGRITY_FAILED");
      current.close(); current = null;
      await rename(activePath, rollbackPath);
    }
    for (const suffix of ["-wal", "-shm"]) if (await exists(`${activePath}${suffix}`)) await rm(`${activePath}${suffix}`, { force: true });
    await rename(normalizedPath, activePath);
    replacementInstalled = true;
    const restored = new SqliteEvidenceStore(activePath);
    const integrity = restored.integrity();
    restored.close();
    if (integrity.status !== "OK") throw new Error("RESTORED_DATABASE_INTEGRITY_FAILED");
    if (await exists(rollbackPath)) await rm(rollbackPath, { force: true });
    return { receiptId: `restore-${token}`, operation: "SQLITE_RESTORE", status: "SUCCEEDED", occurredAt, sourcePath: candidatePath, destinationPath: activePath, sourceSha256: sha256(candidateBytes), sourceBytes: candidateBytes.byteLength, backupPath: await exists(backupPath) ? backupPath : null, integrity };
  } catch (error) {
    candidate?.close(); candidate = null;
    current?.close(); current = null;
    if (replacementInstalled && await exists(activePath)) await rm(activePath, { force: true });
    if (await exists(rollbackPath)) await rename(rollbackPath, activePath);
    throw error;
  } finally {
    candidate?.close(); current?.close();
    if (await exists(normalizedPath)) await rm(normalizedPath, { force: true });
  }
}
