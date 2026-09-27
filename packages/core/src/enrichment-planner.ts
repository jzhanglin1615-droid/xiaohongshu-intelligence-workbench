import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContract,
  type EnrichmentPlan,
  type EnrichmentTask,
  type BlockedEnrichmentTarget,
  type NoteCompletenessLedger,
  type RankingLedger,
} from "../../contracts/src/index.ts";

export interface EnrichmentPolicy {
  maxTargets: number;
  includeComments: boolean;
}

export interface EnrichmentPlanInput {
  planId: string;
  rankingLedger: RankingLedger;
  completeness: NoteCompletenessLedger[];
  policy: EnrichmentPolicy;
  createdAt: string;
}

function targetId(noteId: string): string {
  return `enrich-${createHash("sha256").update(noteId, "utf8").digest("hex").slice(0, 16)}`;
}

export function buildEnrichmentPlan(input: EnrichmentPlanInput): EnrichmentPlan {
  if (!Number.isInteger(input.policy.maxTargets) || input.policy.maxTargets < 1 || input.policy.maxTargets > 500) {
    throw new Error("maxTargets must be an integer between 1 and 500.");
  }
  const completenessByNote = new Map(input.completeness.map((ledger) => [ledger.noteId, ledger]));
  const candidates: EnrichmentTask[] = [];
  const blockedTargets: BlockedEnrichmentTarget[] = [];

  for (const signal of input.rankingLedger.latestSignals) {
    if (signal.kind === "DROPPED" || signal.kind === "NOT_OBSERVED") continue;
    const ledger = completenessByNote.get(signal.noteId);
    const blockedReasons = ledger
      ? [
          ledger.detail.status === "INACCESSIBLE" || ledger.detail.status === "DRIFTED" || ledger.detail.status === "HUMAN_REQUIRED"
            ? `DETAIL_${ledger.detail.status}`
            : null,
          ledger.comments.status === "INACCESSIBLE" || ledger.comments.status === "DRIFTED" || ledger.comments.status === "HUMAN_REQUIRED"
            ? `COMMENTS_${ledger.comments.status}`
            : null,
        ].filter((reason): reason is string => reason !== null)
      : [];
    if (blockedReasons.length > 0) {
      blockedTargets.push({
        noteId: signal.noteId,
        reasons: blockedReasons,
        rankingSignal: signal.kind,
      });
      continue;
    }
    const stages: EnrichmentTask["stages"] = [];
    const reasons = [signal.kind];
    let priority = signal.priorityScore;

    if (!ledger || ledger.detail.status !== "COMPLETE") {
      stages.push("DETAIL");
      reasons.push(ledger ? `DETAIL_${ledger.detail.status}` : "DETAIL_NOT_OBSERVED");
      priority += 12;
    }
    if (input.policy.includeComments && (!ledger || ledger.comments.status !== "COMPLETE")) {
      stages.push("COMMENTS");
      reasons.push(ledger ? `COMMENTS_${ledger.comments.status}` : "COMMENTS_NOT_OBSERVED");
      priority += ledger?.comments.status === "PARTIAL" ? 18 : 12;
    }
    if (stages.length === 0) continue;

    candidates.push({
      targetId: targetId(signal.noteId),
      noteId: signal.noteId,
      priority: Math.min(100, priority),
      stages,
      reasons,
      rankingSignal: signal.kind,
      currentRank: signal.currentRank,
    });
  }

  candidates.sort((a, b) => b.priority - a.priority
    || (a.currentRank ?? Number.MAX_SAFE_INTEGER) - (b.currentRank ?? Number.MAX_SAFE_INTEGER)
    || a.noteId.localeCompare(b.noteId));
  const tasks = candidates.slice(0, input.policy.maxTargets);
  const plan: EnrichmentPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: input.planId,
    scopeId: input.rankingLedger.scopeId,
    tasks,
    blockedTargets: blockedTargets.sort((a, b) => a.noteId.localeCompare(b.noteId)),
    skippedDueToBudget: candidates.length - tasks.length,
    createdAt: input.createdAt,
  };
  assertContract<EnrichmentPlan>("EnrichmentPlan", plan);
  return plan;
}
