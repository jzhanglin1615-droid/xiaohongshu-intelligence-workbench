import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIntelligenceFixtureDemo } from "./intelligence-demo.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await runIntelligenceFixtureDemo(projectRoot, path.join(projectRoot, "artifacts", "m5-explainable-analysis"));
console.log(JSON.stringify({ reportPath: result.reportPath, databasePath: result.databasePath }, null, 2));
