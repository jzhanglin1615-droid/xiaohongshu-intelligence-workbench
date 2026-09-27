import { mkdirSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import type { EvidenceStore, UpsertResult } from "./ports.ts";
import { mergeCanonicalNotes } from "./normalizer.ts";

type JsonEntity =
  | RawEnvelope | Checkpoint | RetryQueueSnapshot | RankingLedger
  | NoteCompletenessLedger | EnrichmentPlan | CollectionRunLedger
  | ViralCandidateAssessment | ContentDecisionCard | QualityDecision;

export interface NoteSearchFilters {
  author?: string;
  keyword?: string;
  detailStatus?: CanonicalNote["detailStatus"];
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface SavedView {
  viewId: string;
  name: string;
  query: string;
  filters: NoteSearchFilters;
  createdAt: string;
  updatedAt: string;
}

export interface StoreIntegrityReport {
  status: "OK" | "FAILED";
  sqliteResult: string;
  schemaVersion: number;
  entityCount: number;
  noteCount: number;
  auditCount: number;
}

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const json = (value: unknown): string => JSON.stringify(value);
const quoteFtsTerm = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const ftsExpression = (query: string): string => query.trim().split(/\s+/u).filter(Boolean).map(quoteFtsTerm).join(" AND ");

export class SqliteEvidenceStore implements EvidenceStore {
  readonly filePath: string;
  readonly database: DatabaseSync;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const current = Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version);
    if (current < 1) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE entities(
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            scope_id TEXT,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(kind, entity_id)
          );
          CREATE INDEX entities_kind_scope ON entities(kind, scope_id);
          CREATE TABLE notes(
            note_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT,
            author_name TEXT NOT NULL,
            detail_status TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload))
          );
          CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, title, body, author_name, keywords, tokenize='trigram');
          CREATE TABLE audit_log(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            details TEXT NOT NULL CHECK(json_valid(details))
          );
          INSERT INTO schema_migrations(version, applied_at) VALUES(1, datetime('now'));
        `);
      });
    }
    if (current < 2) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE note_tags(
            note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(note_id, tag)
          );
          CREATE INDEX note_tags_tag ON note_tags(tag);
          CREATE TABLE saved_views(
            view_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            query TEXT NOT NULL,
            filters TEXT NOT NULL CHECK(json_valid(filters)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO schema_migrations(version, applied_at) VALUES(2, datetime('now'));
        `);
      });
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private put(kind: string, entityId: string, value: JsonEntity, scopeId: string | null = null, updatedAt = new Date().toISOString()): void {
    this.database.prepare(`INSERT INTO entities(kind, entity_id, scope_id, updated_at, payload) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(kind, entity_id) DO UPDATE SET scope_id=excluded.scope_id, updated_at=excluded.updated_at, payload=excluded.payload`)
      .run(kind, entityId, scopeId, updatedAt, json(value));
  }

  private get<T>(kind: string, entityId: string): T | null {
    const row = this.database.prepare("SELECT payload FROM entities WHERE kind=? AND entity_id=?").get(kind, entityId) as { payload: string } | undefined;
    return row ? parse<T>(row.payload) : null;
  }

  private list<T>(kind: string, scopeId?: string): T[] {
    const rows = scopeId === undefined
      ? this.database.prepare("SELECT payload FROM entities WHERE kind=? ORDER BY entity_id").all(kind)
      : this.database.prepare("SELECT payload FROM entities WHERE kind=? AND scope_id=? ORDER BY entity_id").all(kind, scopeId);
    return rows.map((row) => parse<T>((row as { payload: string }).payload));
  }

  private audit(action: string, kind: string, entityId: string, details: unknown = {}): void {
    this.database.prepare("INSERT INTO audit_log(occurred_at, action, entity_kind, entity_id, details) VALUES(?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), action, kind, entityId, json(details));
  }

  async saveRawEnvelopes(values: RawEnvelope[]): Promise<void> { this.transaction(() => values.forEach((v) => { this.put("RAW_ENVELOPE", v.envelopeId, v, v.kind, v.collectedAt); this.audit("UPSERT", "RAW_ENVELOPE", v.envelopeId); })); }
  async getRawEnvelope(id: string): Promise<RawEnvelope | null> { return this.get("RAW_ENVELOPE", id); }
  async listRawEnvelopes(): Promise<RawEnvelope[]> { return this.list("RAW_ENVELOPE"); }

  async upsertNotes(values: CanonicalNote[]): Promise<UpsertResult> {
    let inserted = 0;
    let updated = 0;
    this.transaction(() => {
      const select = this.database.prepare("SELECT payload FROM notes WHERE note_id=?");
      const upsert = this.database.prepare(`INSERT INTO notes(note_id,title,body,author_name,detail_status,observed_at,payload) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(note_id) DO UPDATE SET title=excluded.title,body=excluded.body,author_name=excluded.author_name,detail_status=excluded.detail_status,observed_at=excluded.observed_at,payload=excluded.payload`);
      const deleteFts = this.database.prepare("DELETE FROM notes_fts WHERE note_id=?");
      const insertFts = this.database.prepare("INSERT INTO notes_fts(note_id,title,body,author_name,keywords) VALUES(?,?,?,?,?)");
      for (const incoming of values) {
        const row = select.get(incoming.noteId) as { payload: string } | undefined;
        const note = row ? mergeCanonicalNotes(parse<CanonicalNote>(row.payload), incoming) : incoming;
        row ? updated += 1 : inserted += 1;
        upsert.run(note.noteId, note.title, note.body, note.author.displayName, note.detailStatus, note.metrics.observedAt, json(note));
        deleteFts.run(note.noteId);
        insertFts.run(note.noteId, note.title, note.body ?? "", note.author.displayName, note.keywords.join(" "));
      }
      this.audit("UPSERT_BATCH", "NOTE", `${values.length}`, { inserted, updated });
    });
    return { inserted, updated, total: Number((this.database.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count) };
  }

  async listNotes(): Promise<CanonicalNote[]> { return (this.database.prepare("SELECT payload FROM notes ORDER BY note_id").all() as Array<{ payload: string }>).map((r) => parse(r.payload)); }

  async searchNotes(query = "", filters: NoteSearchFilters = {}): Promise<CanonicalNote[]> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const joins: string[] = [];
    const terms = query.trim().split(/\s+/u).filter(Boolean);
    const indexedTerms = terms.filter((term) => Array.from(term).length >= 3);
    const shortTerms = terms.filter((term) => Array.from(term).length < 3);
    if (indexedTerms.length) { joins.push("JOIN notes_fts f ON f.note_id=n.note_id"); clauses.push("notes_fts MATCH ?"); parameters.push(ftsExpression(indexedTerms.join(" "))); }
    for (const term of shortTerms) {
      const like = `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      clauses.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.author_name LIKE ? ESCAPE '\\' OR n.payload LIKE ? ESCAPE '\\')");
      parameters.push(like, like, like, like);
    }
    if (filters.tag) { joins.push("JOIN note_tags t ON t.note_id=n.note_id"); clauses.push("t.tag=?"); parameters.push(filters.tag); }
    if (filters.author) { clauses.push("n.author_name LIKE ? ESCAPE '\\'"); parameters.push(`%${filters.author.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`); }
    if (filters.detailStatus) { clauses.push("n.detail_status=?"); parameters.push(filters.detailStatus); }
    if (filters.keyword) { clauses.push("EXISTS (SELECT 1 FROM json_each(n.payload, '$.keywords') WHERE value=?)"); parameters.push(filters.keyword); }
    const limit = Math.max(1, Math.min(500, filters.limit ?? 100));
    const offset = Math.max(0, filters.offset ?? 0);
    parameters.push(limit, offset);
    const rows = this.database.prepare(`SELECT DISTINCT n.payload FROM notes n ${joins.join(" ")} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY n.observed_at DESC, n.note_id LIMIT ? OFFSET ?`).all(...parameters) as Array<{ payload: string }>;
    return rows.map((r) => parse(r.payload));
  }

  async setNoteTags(noteId: string, tags: string[], at = new Date().toISOString()): Promise<string[]> {
    if (!this.database.prepare("SELECT 1 FROM notes WHERE note_id=?").get(noteId)) throw new Error("NOTE_NOT_FOUND");
    const normalized = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
    this.transaction(() => {
      this.database.prepare("DELETE FROM note_tags WHERE note_id=?").run(noteId);
      const insert = this.database.prepare("INSERT INTO note_tags(note_id,tag,created_at) VALUES(?,?,?)");
      normalized.forEach((tag) => insert.run(noteId, tag, at));
      this.audit("SET_TAGS", "NOTE", noteId, { tags: normalized });
    });
    return normalized;
  }

  async listNoteTags(noteId: string): Promise<string[]> { return (this.database.prepare("SELECT tag FROM note_tags WHERE note_id=? ORDER BY tag").all(noteId) as Array<{ tag: string }>).map((r) => r.tag); }

  async saveView(view: SavedView): Promise<void> {
    this.database.prepare(`INSERT INTO saved_views(view_id,name,query,filters,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(view_id) DO UPDATE SET name=excluded.name,query=excluded.query,filters=excluded.filters,updated_at=excluded.updated_at`)
      .run(view.viewId, view.name, view.query, json(view.filters), view.createdAt, view.updatedAt);
    this.audit("UPSERT", "SAVED_VIEW", view.viewId);
  }
  async listViews(): Promise<SavedView[]> { return (this.database.prepare("SELECT * FROM saved_views ORDER BY name,view_id").all() as Array<Record<string, unknown>>).map((r) => ({ viewId: String(r.view_id), name: String(r.name), query: String(r.query), filters: parse<NoteSearchFilters>(r.filters), createdAt: String(r.created_at), updatedAt: String(r.updated_at) })); }

  async saveQuality(v: QualityDecision[]): Promise<void> { this.transaction(() => v.forEach((x) => this.put("QUALITY", x.entityId, x, x.entityType, x.evaluatedAt))); }
  async listQuality(): Promise<QualityDecision[]> { return this.list("QUALITY"); }
  async saveCheckpoint(v: Checkpoint): Promise<void> { this.transaction(() => this.put("CHECKPOINT", v.taskId, v, null, v.updatedAt)); }
  async getCheckpoint(id: string): Promise<Checkpoint | null> { return this.get("CHECKPOINT", id); }
  async saveRetryQueue(v: RetryQueueSnapshot): Promise<void> { this.transaction(() => this.put("RETRY_QUEUE", v.taskId, v, null, v.updatedAt)); }
  async getRetryQueue(id: string): Promise<RetryQueueSnapshot | null> { return this.get("RETRY_QUEUE", id); }
  async saveRankingLedger(v: RankingLedger): Promise<void> { this.transaction(() => this.put("RANKING_LEDGER", v.scopeId, v, v.scopeId, v.updatedAt)); }
  async getRankingLedger(id: string): Promise<RankingLedger | null> { return this.get("RANKING_LEDGER", id); }
  async saveCompletenessLedger(v: NoteCompletenessLedger): Promise<void> { this.transaction(() => this.put("COMPLETENESS", v.noteId, v, null, v.updatedAt)); }
  async getCompletenessLedger(id: string): Promise<NoteCompletenessLedger | null> { return this.get("COMPLETENESS", id); }
  async listCompletenessLedgers(): Promise<NoteCompletenessLedger[]> { return this.list("COMPLETENESS"); }
  async saveEnrichmentPlan(v: EnrichmentPlan): Promise<void> { this.transaction(() => this.put("ENRICHMENT_PLAN", v.planId, v, v.scopeId, v.createdAt)); }
  async getEnrichmentPlan(id: string): Promise<EnrichmentPlan | null> { return this.get("ENRICHMENT_PLAN", id); }
  async saveCollectionRunLedger(v: CollectionRunLedger): Promise<void> { this.transaction(() => this.put("COLLECTION_RUN", v.runId, v, null, v.updatedAt)); }
  async getCollectionRunLedger(id: string): Promise<CollectionRunLedger | null> { return this.get("COLLECTION_RUN", id); }
  async saveViralAssessments(v: ViralCandidateAssessment[]): Promise<void> { this.transaction(() => v.forEach((x) => this.put("VIRAL_ASSESSMENT", x.assessmentId, x, x.scopeId, x.assessedAt))); }
  async listViralAssessments(scopeId?: string): Promise<ViralCandidateAssessment[]> { return this.list("VIRAL_ASSESSMENT", scopeId); }
  async saveContentDecisionCards(v: ContentDecisionCard[]): Promise<void> { this.transaction(() => v.forEach((x) => this.put("CONTENT_DECISION", x.cardId, x, null, x.createdAt))); }
  async listContentDecisionCards(): Promise<ContentDecisionCard[]> { return this.list("CONTENT_DECISION"); }

  integrity(): StoreIntegrityReport {
    const sqliteResult = String((this.database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check);
    return {
      status: sqliteResult === "ok" ? "OK" : "FAILED",
      sqliteResult,
      schemaVersion: Number((this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version),
      entityCount: Number((this.database.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number }).count),
      noteCount: Number((this.database.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count),
      auditCount: Number((this.database.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count),
    };
  }

  async exportDocument(): Promise<Record<string, unknown>> {
    return {
      storeVersion: "sqlite-2",
      exportedAt: new Date().toISOString(),
      integrity: this.integrity(),
      rawEnvelopes: await this.listRawEnvelopes(), notes: await this.listNotes(), qualityDecisions: await this.listQuality(),
      checkpoints: this.list("CHECKPOINT"), retryQueues: this.list("RETRY_QUEUE"), rankingLedgers: this.list("RANKING_LEDGER"),
      completenessLedgers: await this.listCompletenessLedgers(), enrichmentPlans: this.list("ENRICHMENT_PLAN"), collectionRunLedgers: this.list("COLLECTION_RUN"),
      viralAssessments: await this.listViralAssessments(), contentDecisionCards: await this.listContentDecisionCards(), savedViews: await this.listViews(),
    };
  }

  async backup(destination: string): Promise<StoreIntegrityReport> {
    const target = path.resolve(destination);
    if (target === this.filePath) throw new Error("BACKUP_DESTINATION_MUST_DIFFER");
    await mkdir(path.dirname(target), { recursive: true });
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    await copyFile(this.filePath, target);
    const verification = new SqliteEvidenceStore(target);
    try { return verification.integrity(); } finally { verification.close(); }
  }

  close(): void { this.database.close(); }
}
