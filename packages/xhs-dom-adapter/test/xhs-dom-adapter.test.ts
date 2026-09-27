import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorkbenchError } from "../../core/src/errors.ts";
import {
  BROWSER_PROTOCOL_VERSION,
  XhsDomAdapter,
  parseDomSnapshot,
  type BrowserTransport,
  type CaptureVisiblePageRequest,
  type PageSnapshotMessage,
} from "../src/index.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = path.join(projectRoot, "fixtures", "dom");

async function snapshot(
  fixtureName: string,
  pageType: "SEARCH" | "NOTE_DETAIL",
  status: "VISIBLE" | "HUMAN_REQUIRED" | "UNKNOWN_STRUCTURE" = "VISIBLE",
  correlationId = "task-dom-1",
): Promise<PageSnapshotMessage> {
  const snapshotPath = path.join(fixtureRoot, fixtureName);
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind: "PAGE_SNAPSHOT",
    correlationId,
    snapshot: {
      sourceUrl: pageType === "SEARCH"
        ? "https://example.invalid/search?keyword=AI工具"
        : "https://example.invalid/note/note-001",
      capturedAt: "2026-09-24T00:02:00.000Z",
      pageType,
      status,
      html: await readFile(snapshotPath, "utf8"),
      snapshotPath,
    },
  };
}

test("search DOM observation becomes hashed SEARCH_RESULTS evidence", async () => {
  const envelope = parseDomSnapshot(await snapshot("search-visible-v1.html", "SEARCH"));
  assert.equal(envelope.kind, "SEARCH_RESULTS");
  assert.equal((envelope.payload as { cards: unknown[] }).cards.length, 3);
  assert.match(envelope.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.parserVersion, "xhs-dom-adapter/0.1.0");
});

test("detail DOM observation preserves fields needed by the normalizer", async () => {
  const envelope = parseDomSnapshot(await snapshot("note-detail-visible-v1.html", "NOTE_DETAIL"));
  const payload = envelope.payload as { noteId: string; assets: unknown[] };
  assert.equal(envelope.kind, "NOTE_DETAIL");
  assert.equal(payload.noteId, "note-001");
  assert.equal(payload.assets.length, 2);
});

test("unknown DOM structure fails closed and creates no envelope", async () => {
  const message = await snapshot("unknown-layout.html", "SEARCH");
  assert.throws(
    () => parseDomSnapshot(message),
    (error: unknown) => error instanceof WorkbenchError && error.code === "DOM_STRUCTURE_UNKNOWN" && error.category === "PERMANENT",
  );
});

test("human verification is handed to the user without bypass", async () => {
  const message = await snapshot("human-verification.html", "SEARCH", "HUMAN_REQUIRED");
  assert.throws(
    () => parseDomSnapshot(message),
    (error: unknown) => error instanceof WorkbenchError &&
      error.code === "BROWSER_HUMAN_VERIFICATION_REQUIRED" &&
      error.category === "NEEDS_HUMAN",
  );
});

test("XhsDomAdapter emits only read-only capture requests and applies the task limit", async () => {
  const searchMessage = await snapshot("search-visible-v1.html", "SEARCH", "VISIBLE", "task-dom-1");
  let observedRequest: CaptureVisiblePageRequest | null = null;
  const transport: BrowserTransport = {
    async capture(request) {
      observedRequest = request;
      return { ...searchMessage, correlationId: request.correlationId };
    },
  };
  const adapter = new XhsDomAdapter(transport, "task-dom", () => "2026-09-24T00:00:00.000Z");
  const envelope = await adapter.collectSearch("AI工具", 2);
  assert.equal((envelope.payload as { cards: unknown[] }).cards.length, 2);
  assert.equal(observedRequest?.kind, "CAPTURE_VISIBLE_PAGE");
  assert.equal(observedRequest?.readOnly, true);
  assert.equal(observedRequest?.authorization.interactiveActions, false);
});
