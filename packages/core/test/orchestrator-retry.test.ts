import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FixtureCollector } from "../../../apps/fixture-runner/src/fixture-parser.ts";
import { CONTRACT_VERSION, type RawEnvelope, type TaskSpec } from "../../contracts/src/index.ts";
import { WorkbenchError } from "../src/errors.ts";
import { FileEvidenceStore } from "../src/file-store.ts";
import { LocalExportHub } from "../src/local-exporter.ts";
import { TaskOrchestrator } from "../src/orchestrator.ts";
import type { PlatformCollector } from "../src/ports.ts";
import { FixedClock, SequenceIdProvider } from "../src/runtime.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const task: TaskSpec = {
  schemaVersion: CONTRACT_VERSION,
  taskId: "single-target-retry",
  projectId: "local-researcher",
  goal: "Retry one transiently failed detail without repeating successful details.",
  seedKeywords: ["AI工具"],
  limits: { maxSearchResults: 20, maxNoteDetails: 3 },
  authorization: { readVisiblePages: true, externalApi: false, upload: false, publish: false },
  createdAt: "2026-09-24T00:00:00.000Z",
};

class FailOnceCollector implements PlatformCollector {
  readonly detailCalls: string[] = [];
  private readonly inner = new FixtureCollector(path.join(projectRoot, "fixtures"));
  private failTarget: string | null;

  constructor(failTarget: string | null) {
    this.failTarget = failTarget;
  }

  collectSearch(keyword: string, limit: number): Promise<RawEnvelope> {
    return this.inner.collectSearch(keyword, limit);
  }

  async collectNote(noteId: string): Promise<RawEnvelope> {
    this.detailCalls.push(noteId);
    if (this.failTarget === noteId) {
      this.failTarget = null;
      throw new WorkbenchError({
        category: "RETRYABLE",
        code: "TEMPORARY_READ_FAILURE",
        message: "The visible detail was temporarily unavailable.",
        targetId: noteId,
      });
    }
    return this.inner.collectNote(noteId);
  }
}

test("a persisted retry queue reprocesses only the selected failed detail", async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "xhs-workbench-retry-"));
  t.after(async () => rm(outputDirectory, { recursive: true, force: true }));
  const databasePath = path.join(outputDirectory, "database.json");
  const clock = new FixedClock("2026-09-24T04:00:00.000Z");

  const firstCollector = new FailOnceCollector("note-002");
  const firstStore = new FileEvidenceStore(databasePath);
  const first = new TaskOrchestrator({
    collector: firstCollector,
    store: firstStore,
    exporter: new LocalExportHub(outputDirectory, clock, new SequenceIdProvider()),
    clock,
    ids: new SequenceIdProvider(),
    retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const initial = await first.run(task);
  assert.equal(initial.finalState, "COMPLETED");
  assert.deepEqual(initial.upsert, { inserted: 2, updated: 0, total: 2 });
  assert.deepEqual(initial.failures.map((failure) => failure.targetId), ["note-002"]);
  assert.equal((await firstStore.getRetryQueue(task.taskId))?.items[0]?.state, "QUEUED");

  const secondCollector = new FailOnceCollector(null);
  const secondStore = new FileEvidenceStore(databasePath);
  const restarted = new TaskOrchestrator({
    collector: secondCollector,
    store: secondStore,
    exporter: new LocalExportHub(outputDirectory, clock, new SequenceIdProvider()),
    clock,
    ids: new SequenceIdProvider(),
    retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const retried = await restarted.retryTarget(task, "note-002");
  assert.equal(retried.outcome, "RESOLVED");
  assert.deepEqual(retried.upsert, { inserted: 1, updated: 0, total: 3 });
  assert.deepEqual(secondCollector.detailCalls, ["note-002"]);
  assert.equal(retried.receipts.length, 2);
  assert.equal((await secondStore.getRetryQueue(task.taskId))?.items[0]?.state, "RESOLVED");
  assert.equal((await secondStore.getCheckpoint(task.taskId))?.failedTargets.length, 0);
  assert.deepEqual((await secondStore.listNotes()).map((note) => note.noteId), ["note-001", "note-002", "note-003"]);
});
