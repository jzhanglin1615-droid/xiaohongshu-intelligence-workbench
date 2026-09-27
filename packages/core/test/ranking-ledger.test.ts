import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type RankingSnapshot } from "../../contracts/src/index.ts";
import { WorkbenchError } from "../src/errors.ts";
import { appendRankingSnapshot } from "../src/ranking-ledger.ts";

function snapshot(input: {
  id: string;
  at: string;
  coverage: RankingSnapshot["coverage"];
  noteIds: string[];
  expectedSlots?: number | null;
}): RankingSnapshot {
  return {
    schemaVersion: CONTRACT_VERSION,
    snapshotId: input.id,
    scopeId: "ranking:discovery:daily",
    scopeLabel: "发现页日榜",
    coverage: input.coverage,
    expectedSlots: input.expectedSlots ?? null,
    entries: input.noteIds.map((noteId, index) => ({
      noteId,
      rank: index + 1,
      sourceEnvelopeId: `raw-${input.id}-${noteId}`,
    })),
    observedAt: input.at,
  };
}

test("complete ranking snapshots produce auditable movement and drop signals", () => {
  const first = appendRankingSnapshot(null, snapshot({
    id: "rank-001",
    at: "2026-09-24T04:00:00.000Z",
    coverage: "COMPLETE",
    expectedSlots: 3,
    noteIds: ["a", "b", "c"],
  }));
  const second = appendRankingSnapshot(first, snapshot({
    id: "rank-002",
    at: "2026-09-24T05:00:00.000Z",
    coverage: "COMPLETE",
    expectedSlots: 3,
    noteIds: ["b", "d", "a"],
  }));
  const byId = Object.fromEntries(second.latestSignals.map((signal) => [signal.noteId, signal]));
  assert.equal(byId.b.kind, "RISING");
  assert.equal(byId.a.kind, "FALLING");
  assert.equal(byId.c.kind, "DROPPED");
  assert.equal(byId.d.kind, "NEW_ENTRY");
  assert.equal(byId.b.rankDelta, 1);
});

test("partial ranking snapshots mark omissions NOT_OBSERVED instead of inventing drops", () => {
  const first = appendRankingSnapshot(null, snapshot({
    id: "rank-001",
    at: "2026-09-24T04:00:00.000Z",
    coverage: "COMPLETE",
    expectedSlots: 2,
    noteIds: ["a", "b"],
  }));
  const partial = appendRankingSnapshot(first, snapshot({
    id: "rank-002",
    at: "2026-09-24T05:00:00.000Z",
    coverage: "PARTIAL",
    noteIds: ["a"],
  }));
  assert.equal(partial.latestSignals.find((signal) => signal.noteId === "b")?.kind, "NOT_OBSERVED");
  assert.equal(partial.latestSignals.some((signal) => signal.kind === "DROPPED"), false);
});

test("ranking snapshot IDs are idempotent but conflicting evidence is blocked", () => {
  const original = snapshot({
    id: "rank-001",
    at: "2026-09-24T04:00:00.000Z",
    coverage: "COMPLETE",
    expectedSlots: 1,
    noteIds: ["a"],
  });
  const ledger = appendRankingSnapshot(null, original);
  assert.equal(appendRankingSnapshot(ledger, original), ledger);
  assert.throws(
    () => appendRankingSnapshot(ledger, { ...original, scopeLabel: "conflict" }),
    (error: unknown) => error instanceof WorkbenchError && error.code === "RANKING_SNAPSHOT_CONFLICT",
  );
});
