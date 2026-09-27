import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  assertContract,
  type ExportReceipt,
  type TaskSpec,
} from "../../contracts/src/index.ts";
import type { Clock, ExportableRow, ExportHub, IdProvider } from "./ports.ts";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows: ExportableRow[]): string {
  const header = [
    "noteId",
    "title",
    "body",
    "authorId",
    "authorName",
    "likes",
    "collects",
    "comments",
    "shares",
    "observedAt",
    "keywords",
    "detailStatus",
    "qualityDecision",
    "qualityIssues",
    "assetCount",
    "expectedAssetCount",
    "sourceUrls",
  ];
  const lines = rows.map(({ note, quality }) => [
    note.noteId,
    note.title,
    note.body,
    note.author.authorId,
    note.author.displayName,
    note.metrics.likes,
    note.metrics.collects,
    note.metrics.comments,
    note.metrics.shares,
    note.metrics.observedAt,
    note.keywords.join("|"),
    note.detailStatus,
    quality.decision,
    quality.issues.map((issue) => issue.code).join("|"),
    note.assets.length,
    note.expectedAssetCount,
    note.provenance.sourceUrls.join("|"),
  ].map(csvCell).join(","));
  return `${header.map(csvCell).join(",")}\n${lines.join("\n")}\n`;
}

export class LocalExportHub implements ExportHub {
  readonly outputDirectory: string;
  private readonly clock: Clock;
  private readonly ids: IdProvider;

  constructor(outputDirectory: string, clock: Clock, ids: IdProvider) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.clock = clock;
    this.ids = ids;
  }

  async exportRows(task: TaskSpec, rows: ExportableRow[]): Promise<ExportReceipt[]> {
    await mkdir(this.outputDirectory, { recursive: true });
    const failedCount = rows.filter((row) => row.quality.decision === "BLOCK").length;
    const jsonContent = `${JSON.stringify({ schemaVersion: CONTRACT_VERSION, task, rows }, null, 2)}\n`;
    const csvContent = toCsv(rows);
    const outputs = [
      { format: "JSON" as const, fileName: `${task.taskId}.json`, content: jsonContent },
      { format: "CSV" as const, fileName: `${task.taskId}.csv`, content: csvContent },
    ];
    const receipts: ExportReceipt[] = [];

    for (const output of outputs) {
      const outputPath = path.join(this.outputDirectory, output.fileName);
      await writeFile(outputPath, output.content, "utf8");
      const receipt: ExportReceipt = {
        schemaVersion: CONTRACT_VERSION,
        exportId: this.ids.next("export"),
        taskId: task.taskId,
        format: output.format,
        outputPath,
        rowCount: rows.length,
        failedCount,
        sha256: sha256(output.content),
        fieldsVersion: "1.0.0",
        createdAt: this.clock.now(),
      };
      assertContract<ExportReceipt>("ExportReceipt", receipt);
      receipts.push(receipt);
    }
    await writeFile(
      path.join(this.outputDirectory, `${task.taskId}.receipts.json`),
      `${JSON.stringify(receipts, null, 2)}\n`,
      "utf8",
    );
    return receipts;
  }
}
