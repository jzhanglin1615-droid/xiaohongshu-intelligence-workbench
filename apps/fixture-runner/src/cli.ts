import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFixtureDemo } from "./demo.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const outputDirectory = path.join(projectRoot, "artifacts", "m1-demo");
const result = await runFixtureDemo(projectRoot, outputDirectory, { resetGeneratedStore: true });
const report = {
  status: result.secondRun.finalState,
  taskId: result.task.taskId,
  firstRun: {
    searchCards: result.firstRun.collectedSearchCards,
    attemptedDetails: result.firstRun.attemptedDetails,
    inserted: result.firstRun.upsert.inserted,
    updated: result.firstRun.upsert.updated,
    total: result.firstRun.upsert.total,
  },
  secondRun: {
    inserted: result.secondRun.upsert.inserted,
    updated: result.secondRun.upsert.updated,
    total: result.secondRun.upsert.total,
  },
  quality: Object.fromEntries(
    result.secondRun.quality.map((decision) => [decision.entityId, decision.decision]),
  ),
  receipts: result.secondRun.receipts,
  externalActions: {
    api: false,
    upload: false,
    publish: false,
  },
};
await writeFile(path.join(outputDirectory, "demo-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
