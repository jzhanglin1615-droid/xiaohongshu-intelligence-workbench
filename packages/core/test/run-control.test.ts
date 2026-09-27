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
import type { PlatformCollector, RunControl, RunControlContext, RunControlDecision } from "../src/ports.ts";
import { FixedClock, SequenceIdProvider } from "../src/runtime.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function task(taskId: string): TaskSpec {
  return {
    schemaVersion: CONTRACT_VERSION,
    taskId,
    projectId: "local-researcher",
    goal: "Verify local run controls without platform access.",
    seedKeywords: ["AI工具"],
    limits: { maxSearchResults: 20, maxNoteDetails: 3 },
    authorization: { readVisiblePages: true, externalApi: false, upload: false, publish: false },
    createdAt: "2026-09-24T00:00:00.000Z",
  };
}

class PauseOnceBeforeSecondDetail implements RunControl {
  private paused = false;

  async decide(context: RunControlContext): Promise<RunControlDecision> {
    if (!this.paused && context.stage === "BEFORE_DETAIL" && context.targetId === "note-002") {
      this.paused = true;
      return "PAUSE";
    }
    return "CONTINUE";
  }
}

class CancelBeforeSearch implements RunControl {
  async decide(context: RunControlContext): Promise<RunControlDecision> {
    return context.stage === "BEFORE_SEARCH" ? "CANCEL" : "CONTINUE";
  }
}

class CountingCollector implements PlatformCollector {
  readonly detailCalls: string[] = [];
  private readonly inner = new FixtureCollector(path.join(projectRoot, "fixtures"));
  private humanBlockTarget: string | null;

  constructor(humanBlockTarget: string | null = null) {
    this.humanBlockTarget = humanBlockTarget;
  }

  async collectSearch(keyword: string, limit: number): Promise<RawEnvelope> {
    return this.inner.collectSearch(keyword, limit);
  }

  async collectNote(noteId: string): Promise<RawEnvelope> {
    this.detailCalls.push(noteId);
    if (this.humanBlockTarget === noteId) {
      this.humanBlockTarget = null;
      throw new WorkbenchError({
        category: "NEEDS_HUMAN",
        code: "HUMAN_VERIFICATION_REQUIRED",
        message: "A human must resolve the visible verification step.",
        targetId: noteId,
      });
    }
    return this.inner.collectNote(noteId);
  }
}

async function harness(control?: RunControl, humanBlockTarget: string | null = null) {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "xhs-workbench-control-"));
  const clock = new FixedClock("2026-09-24T02:00:00.000Z");
  const ids = new SequenceIdProvider();
  const collector = new CountingCollector(humanBlockTarget);
  const store = new FileEvidenceStore(path.join(outputDirectory, "database.json"));
  const exporter = new LocalExportHub(outputDirectory, clock, ids);
  const orchestrator = new TaskOrchestrator({ collector, store, exporter, clock, ids, control });
  return { outputDirectory, collector, store, orchestrator };
}

test("pause checkpoint resumes without recollecting committed details", async (t) => {
  const run = await harness(new PauseOnceBeforeSecondDetail());
  t.after(async () => rm(run.outputDirectory, { recursive: true, force: true }));
  const spec = task("pause-resume-local");

  const paused = await run.orchestrator.run(spec);
  assert.equal(paused.finalState, "PAUSED");
  assert.deepEqual(paused.upsert, { inserted: 1, updated: 0, total: 1 });
  assert.deepEqual((await run.store.getCheckpoint(spec.taskId))?.completedTargets, ["note-001"]);

  const resumed = await run.orchestrator.resume(spec);
  assert.equal(resumed.finalState, "COMPLETED");
  assert.deepEqual(resumed.upsert, { inserted: 2, updated: 0, total: 3 });
  assert.equal(run.collector.detailCalls.filter((noteId) => noteId === "note-001").length, 1);
  assert.equal(resumed.receipts.length, 2);
});

test("human verification stops the run and retries only after explicit resume", async (t) => {
  const run = await harness(undefined, "note-002");
  t.after(async () => rm(run.outputDirectory, { recursive: true, force: true }));
  const spec = task("human-resume-local");

  const blocked = await run.orchestrator.run(spec);
  assert.equal(blocked.finalState, "NEEDS_HUMAN");
  assert.equal(blocked.failures[0]?.code, "HUMAN_VERIFICATION_REQUIRED");
  assert.deepEqual(blocked.upsert, { inserted: 1, updated: 0, total: 1 });

  const resumed = await run.orchestrator.resume(spec);
  assert.equal(resumed.finalState, "COMPLETED");
  assert.equal(resumed.failures.length, 0);
  assert.equal(run.collector.detailCalls.filter((noteId) => noteId === "note-001").length, 1);
  assert.equal(run.collector.detailCalls.filter((noteId) => noteId === "note-002").length, 2);
});

test("cancel before search reaches a terminal state without collection or export", async (t) => {
  const run = await harness(new CancelBeforeSearch());
  t.after(async () => rm(run.outputDirectory, { recursive: true, force: true }));

  const cancelled = await run.orchestrator.run(task("cancel-local"));
  assert.equal(cancelled.finalState, "CANCELLED");
  assert.equal(cancelled.collectedSearchCards, 0);
  assert.equal(cancelled.attemptedDetails, 0);
  assert.equal(cancelled.receipts.length, 0);
  assert.deepEqual(run.collector.detailCalls, []);
});

test("a paused checkpoint survives reconstruction of the local process", async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "xhs-workbench-restart-"));
  t.after(async () => rm(outputDirectory, { recursive: true, force: true }));
  const databasePath = path.join(outputDirectory, "database.json");
  const spec = task("restart-resume-local");
  const clock = new FixedClock("2026-09-24T02:00:00.000Z");

  const firstCollector = new CountingCollector();
  const first = new TaskOrchestrator({
    collector: firstCollector,
    store: new FileEvidenceStore(databasePath),
    exporter: new LocalExportHub(outputDirectory, clock, new SequenceIdProvider()),
    clock,
    ids: new SequenceIdProvider(),
    control: new PauseOnceBeforeSecondDetail(),
  });
  assert.equal((await first.run(spec)).finalState, "PAUSED");
  assert.deepEqual(firstCollector.detailCalls, ["note-001"]);

  const restartedCollector = new CountingCollector();
  const restarted = new TaskOrchestrator({
    collector: restartedCollector,
    store: new FileEvidenceStore(databasePath),
    exporter: new LocalExportHub(outputDirectory, clock, new SequenceIdProvider()),
    clock,
    ids: new SequenceIdProvider(),
  });
  const resumed = await restarted.resume(spec);
  assert.equal(resumed.finalState, "COMPLETED");
  assert.deepEqual(restartedCollector.detailCalls, ["note-002", "note-003"]);
});
