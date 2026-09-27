import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runFixtureDemo } from "../../../apps/fixture-runner/src/demo.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("M1 offline vertical slice is idempotent and produces verifiable exports", async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "xhs-workbench-m1-"));
  t.after(async () => rm(outputDirectory, { recursive: true, force: true }));

  const result = await runFixtureDemo(projectRoot, outputDirectory, { resetGeneratedStore: true });
  assert.equal(result.firstRun.finalState, "COMPLETED");
  assert.equal(result.firstRun.collectedSearchCards, 4);
  assert.equal(result.firstRun.attemptedDetails, 3);
  assert.deepEqual(result.firstRun.upsert, { inserted: 3, updated: 0, total: 3 });
  assert.deepEqual(result.secondRun.upsert, { inserted: 0, updated: 3, total: 3 });
  assert.equal(result.secondRun.failures.length, 0);
  assert.deepEqual(
    Object.fromEntries(result.secondRun.quality.map((decision) => [decision.entityId, decision.decision])),
    { "note-001": "PASS", "note-002": "WARN", "note-003": "BLOCK" },
  );

  const database = JSON.parse(await readFile(result.databasePath, "utf8")) as {
    notes: unknown[];
    qualityDecisions: unknown[];
    checkpoints: Array<{ state: string }>;
  };
  assert.equal(database.notes.length, 3);
  assert.equal(database.qualityDecisions.length, 3);
  assert.equal(database.checkpoints.at(-1)?.state, "COMPLETED");

  assert.equal(result.secondRun.receipts.length, 2);
  for (const receipt of result.secondRun.receipts) {
    await stat(receipt.outputPath);
    const content = await readFile(receipt.outputPath);
    const actualHash = createHash("sha256").update(content).digest("hex");
    assert.equal(actualHash, receipt.sha256);
    assert.equal(receipt.rowCount, 3);
    assert.equal(receipt.failedCount, 1);
  }

  const jsonExport = JSON.parse(await readFile(path.join(outputDirectory, "m1-offline-demo.json"), "utf8")) as {
    task: { authorization: { readVisiblePages: boolean; externalApi: boolean; upload: boolean; publish: boolean } };
    rows: Array<{ quality: { decision: string } }>;
  };
  assert.deepEqual(jsonExport.task.authorization, {
    readVisiblePages: true,
    externalApi: false,
    upload: false,
    publish: false,
  });
  assert.deepEqual(jsonExport.rows.map((row) => row.quality.decision), ["PASS", "WARN", "BLOCK"]);
});
