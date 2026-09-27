import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "state/project-state.json",
  "state/workbench-runtime.json",
  "artifacts/m5-explainable-analysis/report.json",
  "artifacts/m5-explainable-analysis/collection/database.json",
];

for (const relative of files) {
  const source = path.join(root, "templates/bootstrap", relative);
  const destination = path.join(root, relative);
  await stat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(source, destination, 1); // COPYFILE_EXCL: never overwrite local data.
    console.log(`Created ${relative}`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    console.log(`Kept existing ${relative}`);
  }
}
