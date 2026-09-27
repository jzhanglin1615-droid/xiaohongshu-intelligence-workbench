import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalNote,
  Checkpoint,
  CollectionRunLedger,
  ContentDecisionCard,
  EnrichmentPlan,
  NoteCompletenessLedger,
  QualityDecision,
  RankingLedger,
  RawEnvelope,
  RetryQueueSnapshot,
  ViralCandidateAssessment,
} from "../../contracts/src/index.ts";
import type { EvidenceStore, UpsertResult } from "./ports.ts";
import { mergeCanonicalNotes } from "./normalizer.ts";

interface StoreDocument {
  storeVersion: "1.4.0";
  rawEnvelopes: RawEnvelope[];
  notes: CanonicalNote[];
  qualityDecisions: QualityDecision[];
  checkpoints: Checkpoint[];
  retryQueues: RetryQueueSnapshot[];
  rankingLedgers: RankingLedger[];
  completenessLedgers: NoteCompletenessLedger[];
  enrichmentPlans: EnrichmentPlan[];
  collectionRunLedgers: CollectionRunLedger[];
  viralAssessments: ViralCandidateAssessment[];
  contentDecisionCards: ContentDecisionCard[];
}

const EMPTY_STORE: StoreDocument = {
  storeVersion: "1.4.0",
  rawEnvelopes: [],
  notes: [],
  qualityDecisions: [],
  checkpoints: [],
  retryQueues: [],
  rankingLedgers: [],
  completenessLedgers: [],
  enrichmentPlans: [],
  collectionRunLedgers: [],
  viralAssessments: [],
  contentDecisionCards: [],
};

export class FileEvidenceStore implements EvidenceStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  private async load(): Promise<StoreDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreDocument>;
      return {
        storeVersion: "1.4.0",
        rawEnvelopes: parsed.rawEnvelopes ?? [],
        notes: parsed.notes ?? [],
        qualityDecisions: parsed.qualityDecisions ?? [],
        checkpoints: parsed.checkpoints ?? [],
        retryQueues: parsed.retryQueues ?? [],
        rankingLedgers: parsed.rankingLedgers ?? [],
        completenessLedgers: parsed.completenessLedgers ?? [],
        enrichmentPlans: parsed.enrichmentPlans ?? [],
        collectionRunLedgers: (parsed.collectionRunLedgers ?? []).map((ledger) => ({
          ...ledger,
          targets: ledger.targets.map((target) => ({
            ...target,
            query: target.query ?? null,
            errorHistory: target.errorHistory ?? (target.lastError ? [target.lastError] : []),
          })),
        })),
        viralAssessments: parsed.viralAssessments ?? [],
        contentDecisionCards: parsed.contentDecisionCards ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STORE);
      throw error;
    }
  }

  async saveRawEnvelopes(envelopes: RawEnvelope[]): Promise<void> {
    const document = await this.load();
    const byId = new Map(document.rawEnvelopes.map((envelope) => [envelope.envelopeId, envelope]));
    for (const envelope of envelopes) byId.set(envelope.envelopeId, envelope);
    document.rawEnvelopes = [...byId.values()].sort((a, b) => a.envelopeId.localeCompare(b.envelopeId));
    await this.save(document);
  }

  async getRawEnvelope(envelopeId: string): Promise<RawEnvelope | null> {
    return (await this.load()).rawEnvelopes.find((item) => item.envelopeId === envelopeId) ?? null;
  }

  async listRawEnvelopes(): Promise<RawEnvelope[]> {
    return (await this.load()).rawEnvelopes;
  }

  private async save(document: StoreDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  async upsertNotes(notes: CanonicalNote[]): Promise<UpsertResult> {
    const document = await this.load();
    const byId = new Map(document.notes.map((note) => [note.noteId, note]));
    let inserted = 0;
    let updated = 0;
    for (const note of notes) {
      const existing = byId.get(note.noteId);
      if (existing) {
        byId.set(note.noteId, mergeCanonicalNotes(existing, note));
        updated += 1;
      } else {
        byId.set(note.noteId, note);
        inserted += 1;
      }
    }
    document.notes = [...byId.values()].sort((a, b) => a.noteId.localeCompare(b.noteId));
    await this.save(document);
    return { inserted, updated, total: document.notes.length };
  }

  async saveQuality(decisions: QualityDecision[]): Promise<void> {
    const document = await this.load();
    const byId = new Map(document.qualityDecisions.map((decision) => [decision.entityId, decision]));
    for (const decision of decisions) byId.set(decision.entityId, decision);
    document.qualityDecisions = [...byId.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
    await this.save(document);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const document = await this.load();
    const index = document.checkpoints.findIndex((item) => item.taskId === checkpoint.taskId);
    if (index >= 0) document.checkpoints[index] = checkpoint;
    else document.checkpoints.push(checkpoint);
    await this.save(document);
  }

  async getCheckpoint(taskId: string): Promise<Checkpoint | null> {
    return (await this.load()).checkpoints.find((item) => item.taskId === taskId) ?? null;
  }

  async saveRetryQueue(snapshot: RetryQueueSnapshot): Promise<void> {
    const document = await this.load();
    const index = document.retryQueues.findIndex((item) => item.taskId === snapshot.taskId);
    if (index >= 0) document.retryQueues[index] = snapshot;
    else document.retryQueues.push(snapshot);
    await this.save(document);
  }

  async getRetryQueue(taskId: string): Promise<RetryQueueSnapshot | null> {
    return (await this.load()).retryQueues.find((item) => item.taskId === taskId) ?? null;
  }

  async saveRankingLedger(ledger: RankingLedger): Promise<void> {
    const document = await this.load();
    const index = document.rankingLedgers.findIndex((item) => item.scopeId === ledger.scopeId);
    if (index >= 0) document.rankingLedgers[index] = ledger;
    else document.rankingLedgers.push(ledger);
    document.rankingLedgers.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
    await this.save(document);
  }

  async getRankingLedger(scopeId: string): Promise<RankingLedger | null> {
    return (await this.load()).rankingLedgers.find((item) => item.scopeId === scopeId) ?? null;
  }

  async saveCompletenessLedger(ledger: NoteCompletenessLedger): Promise<void> {
    const document = await this.load();
    const index = document.completenessLedgers.findIndex((item) => item.noteId === ledger.noteId);
    if (index >= 0) document.completenessLedgers[index] = ledger;
    else document.completenessLedgers.push(ledger);
    document.completenessLedgers.sort((a, b) => a.noteId.localeCompare(b.noteId));
    await this.save(document);
  }

  async getCompletenessLedger(noteId: string): Promise<NoteCompletenessLedger | null> {
    return (await this.load()).completenessLedgers.find((item) => item.noteId === noteId) ?? null;
  }

  async listCompletenessLedgers(): Promise<NoteCompletenessLedger[]> {
    return (await this.load()).completenessLedgers;
  }

  async saveEnrichmentPlan(plan: EnrichmentPlan): Promise<void> {
    const document = await this.load();
    const index = document.enrichmentPlans.findIndex((item) => item.planId === plan.planId);
    if (index >= 0) document.enrichmentPlans[index] = plan;
    else document.enrichmentPlans.push(plan);
    document.enrichmentPlans.sort((a, b) => a.planId.localeCompare(b.planId));
    await this.save(document);
  }

  async getEnrichmentPlan(planId: string): Promise<EnrichmentPlan | null> {
    return (await this.load()).enrichmentPlans.find((item) => item.planId === planId) ?? null;
  }

  async saveCollectionRunLedger(ledger: CollectionRunLedger): Promise<void> {
    const document = await this.load();
    const index = document.collectionRunLedgers.findIndex((item) => item.runId === ledger.runId);
    if (index >= 0) document.collectionRunLedgers[index] = ledger;
    else document.collectionRunLedgers.push(ledger);
    document.collectionRunLedgers.sort((a, b) => a.runId.localeCompare(b.runId));
    await this.save(document);
  }

  async getCollectionRunLedger(runId: string): Promise<CollectionRunLedger | null> {
    return (await this.load()).collectionRunLedgers.find((item) => item.runId === runId) ?? null;
  }

  async saveViralAssessments(assessments: ViralCandidateAssessment[]): Promise<void> {
    const document = await this.load();
    const byId = new Map(document.viralAssessments.map((item) => [item.assessmentId, item]));
    for (const assessment of assessments) byId.set(assessment.assessmentId, assessment);
    document.viralAssessments = [...byId.values()].sort((a, b) => a.assessmentId.localeCompare(b.assessmentId));
    await this.save(document);
  }

  async listViralAssessments(scopeId?: string): Promise<ViralCandidateAssessment[]> {
    const assessments = (await this.load()).viralAssessments;
    return scopeId ? assessments.filter((item) => item.scopeId === scopeId) : assessments;
  }

  async saveContentDecisionCards(cards: ContentDecisionCard[]): Promise<void> {
    const document = await this.load();
    const byId = new Map(document.contentDecisionCards.map((item) => [item.cardId, item]));
    for (const card of cards) byId.set(card.cardId, card);
    document.contentDecisionCards = [...byId.values()].sort((a, b) => a.cardId.localeCompare(b.cardId));
    await this.save(document);
  }

  async listContentDecisionCards(): Promise<ContentDecisionCard[]> {
    return (await this.load()).contentDecisionCards;
  }

  async listNotes(): Promise<CanonicalNote[]> {
    return (await this.load()).notes;
  }

  async listQuality(): Promise<QualityDecision[]> {
    return (await this.load()).qualityDecisions;
  }
}
