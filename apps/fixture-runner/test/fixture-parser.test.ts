import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFixture } from "../src/fixture-parser.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("search fixture yields a hashed SEARCH_RESULTS evidence envelope", async () => {
  const envelope = await parseFixture(path.join(projectRoot, "fixtures", "search", "seed-ai-tools.html"));
  assert.equal(envelope.kind, "SEARCH_RESULTS");
  assert.match(envelope.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal((envelope.payload as { cards: unknown[] }).cards.length, 4);
});

test("all three detail fixture groups satisfy the raw envelope contract", async () => {
  for (const noteId of ["note-001", "note-002", "note-003"]) {
    const envelope = await parseFixture(path.join(projectRoot, "fixtures", "details", `${noteId}.html`));
    assert.equal(envelope.kind, "NOTE_DETAIL");
    assert.equal((envelope.payload as { noteId: string }).noteId, noteId);
    assert.match(envelope.envelopeId, /^note_detail-[a-f0-9]{16}$/);
  }
});

test("all three comment fixtures preserve comment-page evidence", async () => {
  for (const noteId of ["note-001", "note-002", "note-003"]) {
    const envelope = await parseFixture(path.join(projectRoot, "fixtures", "comments", `${noteId}.html`));
    assert.equal(envelope.kind, "COMMENT_PAGE");
    assert.equal((envelope.payload as { noteId: string }).noteId, noteId);
    assert.match(envelope.envelopeId, /^comment_page-[a-f0-9]{16}$/);
  }
});
