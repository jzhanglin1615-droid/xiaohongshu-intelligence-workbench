import { rm } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  type TaskSpec,
} from "../../../packages/contracts/src/index.ts";
import {
  FileEvidenceStore,
  FixedClock,
  LocalExportHub,
  SequenceIdProvider,
  TaskOrchestrator,
  type RunSummary,
} from "../../../packages/core/src/index.ts";
import { FixtureCollector } from "./fixture-parser.ts";

export interface DemoResult {
  task: TaskSpec;
  firstRun: RunSummary;
  secondRun: RunSummary;
  databasePath: string;
  outputDirectory: string;
}

export async function runFixtureDemo(
  projectRoot: string,
  outputDirectory: string,
  options: { resetGeneratedStore?: boolean } = {},
): Promise<DemoResult> {
  const clock = new FixedClock("2026-09-24T01:00:00.000Z");
  const ids = new SequenceIdProvider();
  const databasePath = path.join(outputDirectory, "database.json");
  if (options.resetGeneratedStore) {
    await rm(databasePath, { force: true });
  }
  const collector = new FixtureCollector(path.join(projectRoot, "fixtures"));
  const store = new FileEvidenceStore(databasePath);
  const exporter = new LocalExportHub(outputDirectory, clock, ids);
  const orchestrator = new TaskOrchestrator({ collector, store, exporter, clock, ids });
  const task: TaskSpec = {
    schemaVersion: CONTRACT_VERSION,
    taskId: "m1-offline-demo",
    projectId: "local-researcher",
    goal: "Prove the offline page-evidence to local-export loop.",
    seedKeywords: ["AI工具"],
    limits: {
      maxSearchResults: 20,
      maxNoteDetails: 3,
    },
    authorization: {
      readVisiblePages: true,
      externalApi: false,
      upload: false,
      publish: false,
    },
    createdAt: "2026-09-24T00:00:00.000Z",
  };

  const firstRun = await orchestrator.run(task);
  const secondRun = await orchestrator.run(task);
  return { task, firstRun, secondRun, databasePath, outputDirectory };
}
