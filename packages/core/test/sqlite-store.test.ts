import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTRACT_VERSION, type CanonicalNote } from "../../contracts/src/index.ts";
import { ingestBrowserSnapshot, type BrowserSnapshotReceipt } from "../src/browser-snapshot-ingestion.ts";
import { migrateLegacyJsonDatabase, restoreSqliteDatabase } from "../src/sqlite-maintenance.ts";
import { SqliteEvidenceStore } from "../src/sqlite-store.ts";

const note = (index: number): CanonicalNote => ({
  schemaVersion: CONTRACT_VERSION, noteId: `note-${String(index).padStart(5, "0")}`,
  title: index % 2 === 0 ? `咖啡教程 ${index}` : `早餐灵感 ${index}`, body: `可检索正文 ${index}`,
  author: { authorId: `author-${index % 20}`, displayName: `作者${index % 20}` },
  metrics: { likes: index, collects: index % 100, comments: index % 30, observedAt: "2026-09-25T02:00:00.000Z" },
  assets: [], expectedAssetCount: 0, keywords: index % 2 === 0 ? ["咖啡"] : ["早餐"], detailStatus: "COMPLETE",
  provenance: { sourceUrls: [`https://www.xiaohongshu.com/explore/note-${index}`], envelopeIds: [`env-${index}`], parserVersions: ["test/1"], collectedAt: ["2026-09-25T02:00:00.000Z"] },
});

const receipt = (id: string, snapshot: Record<string, unknown>): BrowserSnapshotReceipt => ({ receiptId: id, fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshotPath: `state/browser-bridge/snapshots/${id}.json`, snapshot });

test("SQLite store provides migration, full-text search, tags, views, audit, backup, and 10k-scale persistence", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-sqlite-store-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new SqliteEvidenceStore(path.join(directory, "evidence.sqlite"));
  const startedAt = performance.now();
  const upsert = await store.upsertNotes(Array.from({ length: 10_000 }, (_, index) => note(index)));
  const elapsedMs = performance.now() - startedAt;
  assert.deepEqual(upsert, { inserted: 10_000, updated: 0, total: 10_000 });
  assert.ok(elapsedMs < 60_000, `10k upsert took ${elapsedMs}ms`);
  assert.equal((await store.searchNotes("咖啡 教程", { keyword: "咖啡", limit: 25 })).length, 25);
  assert.equal((await store.searchNotes("早餐", { author: "作者1", limit: 500 })).every((item) => item.author.displayName.includes("作者1")), true);
  assert.deepEqual(await store.setNoteTags("note-00002", ["重点", "复刻", "重点"]), ["复刻", "重点"]);
  assert.equal((await store.searchNotes("", { tag: "重点" }))[0].noteId, "note-00002");
  await store.saveView({ viewId: "view-coffee", name: "咖啡重点", query: "咖啡", filters: { tag: "重点" }, createdAt: "2026-09-25T02:00:00.000Z", updatedAt: "2026-09-25T02:00:00.000Z" });
  assert.equal((await store.listViews())[0].viewId, "view-coffee");
  assert.equal(store.integrity().status, "OK"); assert.equal(store.integrity().schemaVersion, 2); assert.equal(store.integrity().noteCount, 10_000);
  const backupPath = path.join(directory, "backups", "evidence.sqlite");
  assert.equal((await store.backup(backupPath)).noteCount, 10_000); await stat(backupPath);
  assert.equal(((await store.exportDocument()).notes as unknown[]).length, 10_000);
  store.close();
});

test("browser snapshot ingestion uses SQLite as its persistence backend", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-sqlite-ingestion-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "browser.sqlite");
  const search = { pageType: "SEARCH", status: "VISIBLE", sourceUrl: "https://www.xiaohongshu.com/search_result?keyword=%E5%92%96%E5%95%A1", capturedAt: "2026-09-25T02:00:00.000Z", keyword: "咖啡", cards: [{ ordinal: 1, noteId: "live-1", title: "咖啡", authorName: "作者", sourceUrl: "https://www.xiaohongshu.com/explore/live-1", likes: 12 }] };
  const detail = { pageType: "NOTE_DETAIL", status: "VISIBLE", sourceUrl: "https://www.xiaohongshu.com/explore/live-1", capturedAt: "2026-09-25T02:01:00.000Z", noteId: "live-1", noteTitle: "咖啡", authorName: "作者", body: "正文", metrics: { likes: 13, collects: 2, comments: 1 }, assets: [], visibleComments: [], commentTraversal: { complete: true } };
  await ingestBrowserSnapshot({ receipt: receipt("sqlite-search", search), databasePath });
  const result = await ingestBrowserSnapshot({ receipt: receipt("sqlite-detail", detail), databasePath });
  assert.deepEqual(result.normalizedNoteIds, ["live-1"]);
  const reopened = new SqliteEvidenceStore(databasePath);
  assert.equal((await reopened.listRawEnvelopes()).length, 3); assert.equal((await reopened.searchNotes("咖啡")).length, 1); assert.equal(reopened.integrity().status, "OK");
  reopened.close();
});

test("legacy JSON database migrates once into a verified SQLite database without deleting its source", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-legacy-migration-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const legacyPath = path.join(directory, "evidence-database.json");
  const sqlitePath = path.join(directory, "evidence-database.sqlite");
  const receiptPath = path.join(directory, "migration-receipt.json");
  const document = { storeVersion: "1.4.0", rawEnvelopes: [], notes: [note(7)], qualityDecisions: [], checkpoints: [], retryQueues: [], rankingLedgers: [], completenessLedgers: [], enrichmentPlans: [], collectionRunLedgers: [], viralAssessments: [], contentDecisionCards: [], savedViews: [{ viewId: "legacy-view", name: "旧视图", query: "早餐", filters: {}, createdAt: "2026-09-25T02:00:00.000Z", updatedAt: "2026-09-25T02:00:00.000Z" }] };
  await writeFile(legacyPath, JSON.stringify(document), "utf8");
  const receipt = await migrateLegacyJsonDatabase({ legacyPath, sqlitePath, receiptPath, occurredAt: "2026-09-25T03:00:00.000Z" });
  assert.equal(receipt?.integrity.status, "OK"); assert.equal(receipt?.counts?.notes, 1);
  assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).notes[0].noteId, "note-00007");
  assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).operation, "LEGACY_JSON_MIGRATION");
  const migrated = new SqliteEvidenceStore(sqlitePath);
  assert.equal((await migrated.listNotes())[0].noteId, "note-00007"); assert.equal((await migrated.listViews())[0].viewId, "legacy-view"); migrated.close();
  assert.equal(await migrateLegacyJsonDatabase({ legacyPath, sqlitePath }), null);
});

test("restore rejects a corrupt candidate and preserves the active database", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-restore-reject-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const activePath = path.join(directory, "active.sqlite");
  const corruptPath = path.join(directory, "corrupt.sqlite");
  const active = new SqliteEvidenceStore(activePath); await active.upsertNotes([note(1)]); active.close();
  await writeFile(corruptPath, "this is not sqlite", "utf8");
  await assert.rejects(restoreSqliteDatabase({ activePath, candidatePath: corruptPath, backupDirectory: path.join(directory, "backups") }));
  const preserved = new SqliteEvidenceStore(activePath); assert.equal((await preserved.listNotes())[0].noteId, "note-00001"); preserved.close();
});

test("restore verifies the candidate, backs up the active database, swaps it, and returns an auditable receipt", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-restore-success-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const activePath = path.join(directory, "active.sqlite"); const candidatePath = path.join(directory, "candidate.sqlite");
  const active = new SqliteEvidenceStore(activePath); await active.upsertNotes([note(1)]); active.close();
  const candidate = new SqliteEvidenceStore(candidatePath); await candidate.upsertNotes([note(22), note(23)]); candidate.close();
  const receipt = await restoreSqliteDatabase({ activePath, candidatePath, backupDirectory: path.join(directory, "backups"), occurredAt: "2026-09-25T04:00:00.000Z" });
  assert.equal(receipt.operation, "SQLITE_RESTORE"); assert.equal(receipt.integrity.noteCount, 2); assert.ok(receipt.backupPath); await stat(receipt.backupPath);
  const restored = new SqliteEvidenceStore(activePath); assert.deepEqual((await restored.listNotes()).map((item) => item.noteId), ["note-00022", "note-00023"]); restored.close();
  const backup = new SqliteEvidenceStore(receipt.backupPath); assert.equal((await backup.listNotes())[0].noteId, "note-00001"); backup.close();
});
