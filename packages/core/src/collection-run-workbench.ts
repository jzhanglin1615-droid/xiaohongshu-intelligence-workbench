import type {
  CollectionRunLedger,
  CollectionRunTarget,
  TaskError,
} from "../../contracts/src/index.ts";
import {
  blockCollectionTarget,
  claimNextCollectionTarget,
  completeCollectionTarget,
  createCollectionRunLedger,
  failCollectionTarget,
  pauseCollectionRun,
  recoverInterruptedCollectionRun,
  retryCollectionTarget,
  resumeCollectionRun,
  type CollectionRunInput,
} from "./collection-run-ledger.ts";
import { WorkbenchError } from "./errors.ts";
import type { EvidenceStore } from "./ports.ts";

export class CollectionRunWorkbench {
  readonly store: EvidenceStore;

  constructor(store: EvidenceStore) {
    this.store = store;
  }

  private async requireRun(runId: string): Promise<CollectionRunLedger> {
    const ledger = await this.store.getCollectionRunLedger(runId);
    if (!ledger) {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_RUN_NOT_FOUND",
        message: "The requested collection run ledger was not found.",
        targetId: runId,
        retryable: false,
      });
    }
    return ledger;
  }

  async create(input: CollectionRunInput): Promise<CollectionRunLedger> {
    if (await this.store.getCollectionRunLedger(input.runId)) {
      throw new WorkbenchError({
        category: "POLICY_BLOCKED",
        code: "COLLECTION_RUN_ALREADY_EXISTS",
        message: "Collection run IDs are immutable and cannot be reused.",
        targetId: input.runId,
        retryable: false,
      });
    }
    const ledger = createCollectionRunLedger(input);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async get(runId: string): Promise<CollectionRunLedger> {
    return this.requireRun(runId);
  }

  async claim(runId: string, now: string): Promise<CollectionRunTarget | null> {
    const claimed = claimNextCollectionTarget(await this.requireRun(runId), now);
    await this.store.saveCollectionRunLedger(claimed.ledger);
    return claimed.target;
  }

  async complete(runId: string, targetId: string, evidenceEnvelopeIds: string[], now: string): Promise<CollectionRunLedger> {
    const ledger = completeCollectionTarget(await this.requireRun(runId), targetId, evidenceEnvelopeIds, now);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async block(runId: string, targetId: string, error: TaskError, now: string, evidenceEnvelopeIds: string[] = []): Promise<CollectionRunLedger> {
    const ledger = blockCollectionTarget(await this.requireRun(runId), targetId, error, now, evidenceEnvelopeIds);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async fail(runId: string, targetId: string, error: TaskError, now: string, evidenceEnvelopeIds: string[] = []): Promise<CollectionRunLedger> {
    const ledger = failCollectionTarget(await this.requireRun(runId), targetId, error, now, evidenceEnvelopeIds);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async retry(runId: string, targetId: string, error: TaskError, now: string, evidenceEnvelopeIds: string[] = []): Promise<CollectionRunLedger> {
    const ledger = retryCollectionTarget(await this.requireRun(runId), targetId, error, now, evidenceEnvelopeIds);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async pause(runId: string, now: string): Promise<CollectionRunLedger> {
    const ledger = pauseCollectionRun(await this.requireRun(runId), now);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async resume(runId: string, now: string): Promise<CollectionRunLedger> {
    const ledger = resumeCollectionRun(await this.requireRun(runId), now);
    await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }

  async recover(runId: string, now: string): Promise<CollectionRunLedger> {
    const current = await this.requireRun(runId);
    const ledger = recoverInterruptedCollectionRun(current, now);
    if (ledger !== current) await this.store.saveCollectionRunLedger(ledger);
    return ledger;
  }
}
