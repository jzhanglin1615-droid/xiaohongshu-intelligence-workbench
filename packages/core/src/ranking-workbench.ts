import type {
  EnrichmentPlan,
  RankingLedger,
  RankingSnapshot,
  NoteCompletenessLedger,
} from "../../contracts/src/index.ts";
import { evaluateNoteCompleteness, type NoteCompletenessObservation } from "./completeness-ledger.ts";
import { buildEnrichmentPlan, type EnrichmentPolicy } from "./enrichment-planner.ts";
import { WorkbenchError } from "./errors.ts";
import type { EvidenceStore } from "./ports.ts";
import { appendRankingSnapshot } from "./ranking-ledger.ts";

export class RankingWorkbench {
  readonly store: EvidenceStore;

  constructor(store: EvidenceStore) {
    this.store = store;
  }

  async recordRankingSnapshot(snapshot: RankingSnapshot): Promise<RankingLedger> {
    const existing = await this.store.getRankingLedger(snapshot.scopeId);
    const ledger = appendRankingSnapshot(existing, snapshot);
    if (ledger !== existing) await this.store.saveRankingLedger(ledger);
    return ledger;
  }

  async recordCompleteness(observation: NoteCompletenessObservation): Promise<NoteCompletenessLedger> {
    const existing = await this.store.getCompletenessLedger(observation.noteId);
    if (existing && Date.parse(observation.observedAt) < Date.parse(existing.updatedAt)) {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COMPLETENESS_OBSERVATION_OUT_OF_ORDER",
        message: "Completeness observations cannot be recorded earlier than the latest observation.",
        targetId: observation.noteId,
        retryable: false,
      });
    }
    const ledger = evaluateNoteCompleteness(observation, existing);
    await this.store.saveCompletenessLedger(ledger);
    return ledger;
  }

  async planEnrichment(input: {
    planId: string;
    scopeId: string;
    policy: EnrichmentPolicy;
    createdAt: string;
  }): Promise<EnrichmentPlan> {
    const rankingLedger = await this.store.getRankingLedger(input.scopeId);
    if (!rankingLedger) {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "RANKING_LEDGER_NOT_FOUND",
        message: "A ranking ledger is required before enrichment can be planned.",
        targetId: input.scopeId,
        retryable: false,
      });
    }
    const plan = buildEnrichmentPlan({
      planId: input.planId,
      rankingLedger,
      completeness: await this.store.listCompletenessLedgers(),
      policy: input.policy,
      createdAt: input.createdAt,
    });
    await this.store.saveEnrichmentPlan(plan);
    return plan;
  }
}
