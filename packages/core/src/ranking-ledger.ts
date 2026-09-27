import {
  CONTRACT_VERSION,
  assertContract,
  type RankingLedger,
  type RankingSignal,
  type RankingSignalKind,
  type RankingSnapshot,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "./errors.ts";

function ledgerError(code: string, message: string, targetId: string): never {
  throw new WorkbenchError({
    category: "POLICY_BLOCKED",
    code,
    message,
    targetId,
    retryable: false,
  });
}

function findFirstSeen(snapshots: RankingSnapshot[], noteId: string): string {
  return snapshots.find((snapshot) => snapshot.entries.some((entry) => entry.noteId === noteId))!.observedAt;
}

function findLastSeen(snapshots: RankingSnapshot[], noteId: string): string {
  return [...snapshots].reverse().find((snapshot) => snapshot.entries.some((entry) => entry.noteId === noteId))!.observedAt;
}

function consecutiveAppearances(snapshots: RankingSnapshot[], noteId: string): number {
  let count = 0;
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (!snapshots[index].entries.some((entry) => entry.noteId === noteId)) break;
    count += 1;
  }
  return count;
}

function signalPriority(kind: RankingSignalKind, currentRank: number | null, rankDelta: number | null, consecutive: number): number {
  const topBoost = currentRank === null ? 0 : Math.max(0, 21 - Math.min(21, currentRank));
  const base = (() => {
    switch (kind) {
      case "NEW_ENTRY": return 65;
      case "REENTERED": return 60;
      case "RISING": return 55 + Math.min(25, Math.max(0, rankDelta ?? 0) * 5);
      case "UNCHANGED": return 25 + Math.min(20, consecutive * 3);
      case "FALLING": return 20;
      case "DROPPED": return 5;
      case "NOT_OBSERVED": return 0;
    }
  })();
  return Math.min(100, Math.round(base + topBoost));
}

function buildSignals(snapshots: RankingSnapshot[]): RankingSignal[] {
  const current = snapshots.at(-1)!;
  const previous = snapshots.at(-2) ?? null;
  const currentById = new Map(current.entries.map((entry) => [entry.noteId, entry]));
  const previousById = new Map((previous?.entries ?? []).map((entry) => [entry.noteId, entry]));
  const noteIds = new Set([...currentById.keys(), ...previousById.keys()]);
  const historyBeforeCurrent = snapshots.slice(0, -1);
  const signals: RankingSignal[] = [];

  for (const noteId of noteIds) {
    const currentEntry = currentById.get(noteId);
    const previousEntry = previousById.get(noteId);
    let kind: RankingSignalKind;
    let rankDelta: number | null = null;

    if (currentEntry && previousEntry) {
      rankDelta = previousEntry.rank - currentEntry.rank;
      kind = rankDelta > 0 ? "RISING" : rankDelta < 0 ? "FALLING" : "UNCHANGED";
    } else if (currentEntry) {
      const appearedBefore = historyBeforeCurrent.some((snapshot) => snapshot.entries.some((entry) => entry.noteId === noteId));
      kind = appearedBefore ? "REENTERED" : "NEW_ENTRY";
    } else {
      kind = current.coverage === "COMPLETE" ? "DROPPED" : "NOT_OBSERVED";
    }

    const consecutive = currentEntry ? consecutiveAppearances(snapshots, noteId) : 0;
    signals.push({
      noteId,
      kind,
      previousRank: previousEntry?.rank ?? null,
      currentRank: currentEntry?.rank ?? null,
      rankDelta,
      consecutiveAppearances: consecutive,
      firstSeenAt: findFirstSeen(snapshots, noteId),
      lastSeenAt: currentEntry ? current.observedAt : findLastSeen(snapshots, noteId),
      priorityScore: signalPriority(kind, currentEntry?.rank ?? null, rankDelta, consecutive),
    });
  }

  return signals.sort((a, b) => b.priorityScore - a.priorityScore
    || (a.currentRank ?? Number.MAX_SAFE_INTEGER) - (b.currentRank ?? Number.MAX_SAFE_INTEGER)
    || a.noteId.localeCompare(b.noteId));
}

export function appendRankingSnapshot(existing: RankingLedger | null, rawSnapshot: RankingSnapshot): RankingLedger {
  const snapshot: RankingSnapshot = {
    ...rawSnapshot,
    entries: [...rawSnapshot.entries].sort((a, b) => a.rank - b.rank || a.noteId.localeCompare(b.noteId)),
  };
  assertContract<RankingSnapshot>("RankingSnapshot", snapshot);

  if (existing && existing.scopeId !== snapshot.scopeId) {
    ledgerError("RANKING_SCOPE_MISMATCH", "Snapshot scope does not match the ranking ledger.", snapshot.scopeId);
  }
  const duplicate = existing?.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(snapshot)) {
      ledgerError("RANKING_SNAPSHOT_CONFLICT", "The snapshot ID already exists with different evidence.", snapshot.snapshotId);
    }
    return existing!;
  }
  const latest = existing?.snapshots.at(-1);
  if (latest && Date.parse(snapshot.observedAt) <= Date.parse(latest.observedAt)) {
    ledgerError("RANKING_SNAPSHOT_OUT_OF_ORDER", "Ranking snapshots must be appended in strictly increasing time order.", snapshot.snapshotId);
  }

  const snapshots = [...(existing?.snapshots ?? []), snapshot];
  const ledger: RankingLedger = {
    schemaVersion: CONTRACT_VERSION,
    scopeId: snapshot.scopeId,
    snapshots,
    latestSignals: buildSignals(snapshots),
    updatedAt: snapshot.observedAt,
  };
  assertContract<RankingLedger>("RankingLedger", ledger);
  return ledger;
}
