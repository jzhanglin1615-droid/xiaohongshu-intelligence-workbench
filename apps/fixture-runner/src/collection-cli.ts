import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCollectionFixtureDemo } from "./collection-demo.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDirectory = path.join(projectRoot, "artifacts", "m2-collection-execution");
const result = await runCollectionFixtureDemo(projectRoot, outputDirectory);
console.log(JSON.stringify({
  reportPath: result.reportPath,
  databasePath: result.databasePath,
  receipt: result.report.receipt,
  readiness: result.report.readiness,
}, null, 2));
