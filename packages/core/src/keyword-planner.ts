import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  assertContract,
  type KeywordEdge,
  type KeywordNode,
  type KeywordPlan,
  type KeywordPolicy,
} from "../../contracts/src/index.ts";
import { WorkbenchError } from "./errors.ts";

export interface KeywordExpansion {
  parent: string;
  children: string[];
}

export interface KeywordPlanInput {
  planId: string;
  taskId: string;
  seedKeywords: string[];
  policy: KeywordPolicy;
  expansions: KeywordExpansion[];
  createdAt: string;
}

export function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function keywordId(normalized: string): string {
  return `kw-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

function policyError(code: string, message: string, targetId: string): never {
  throw new WorkbenchError({
    category: "POLICY_BLOCKED",
    code,
    message,
    targetId,
    retryable: false,
  });
}

function uniqueKeywords(values: string[]): Array<{ value: string; normalized: string }> {
  const seen = new Set<string>();
  const result: Array<{ value: string; normalized: string }> = [];
  for (const raw of values) {
    const value = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
    const normalized = normalizeKeyword(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ value, normalized });
  }
  return result;
}

export function buildKeywordPlan(input: KeywordPlanInput): KeywordPlan {
  const seeds = uniqueKeywords(input.seedKeywords);
  if (seeds.length === 0) {
    policyError("KEYWORD_SEED_REQUIRED", "At least one non-empty seed keyword is required.", input.taskId);
  }

  const excluded = uniqueKeywords(input.policy.excludedTerms).map((item) => item.normalized);
  for (const seed of seeds) {
    if (excluded.some((term) => seed.normalized.includes(term))) {
      policyError(
        "KEYWORD_SEED_EXCLUDED",
        `Seed keyword conflicts with an exclusion rule: ${seed.value}`,
        seed.value,
      );
    }
  }
  if (seeds.length > input.policy.maxKeywords) {
    policyError(
      "KEYWORD_BUDGET_TOO_SMALL",
      `Seed count ${seeds.length} exceeds maxKeywords ${input.policy.maxKeywords}.`,
      input.taskId,
    );
  }
  const seedEstimate = seeds.length * input.policy.noteDetailsPerKeyword;
  if (seedEstimate > input.policy.maxEstimatedNoteDetails) {
    policyError(
      "NOTE_BUDGET_TOO_SMALL",
      `Seed estimate ${seedEstimate} exceeds maxEstimatedNoteDetails ${input.policy.maxEstimatedNoteDetails}.`,
      input.taskId,
    );
  }

  const expansionMap = new Map<string, string[]>();
  for (const expansion of input.expansions) {
    const parent = normalizeKeyword(expansion.parent);
    if (!parent) continue;
    expansionMap.set(parent, [...(expansionMap.get(parent) ?? []), ...expansion.children]);
  }

  const nodes: KeywordNode[] = seeds.map((seed) => ({
    keywordId: keywordId(seed.normalized),
    value: seed.value,
    normalized: seed.normalized,
    depth: 0,
    source: "SEED",
    status: "QUEUED",
  }));
  const nodeByNormalized = new Map(nodes.map((node) => [node.normalized, node]));
  const edges: KeywordEdge[] = [];
  const edgeKeys = new Set<string>();
  const truncation = {
    hitKeywordLimit: false,
    hitNoteBudget: false,
    prunedByDepth: 0,
    prunedByExclusion: 0,
    prunedByChildLimit: 0,
  };

  for (let cursor = 0; cursor < nodes.length; cursor += 1) {
    const parent = nodes[cursor];
    const candidates = uniqueKeywords(expansionMap.get(parent.normalized) ?? [])
      .filter((candidate) => candidate.normalized !== parent.normalized);
    if (parent.depth >= input.policy.maxDepth) {
      truncation.prunedByDepth += candidates.length;
      continue;
    }

    let acceptedChildren = 0;
    for (const candidate of candidates) {
      if (excluded.some((term) => candidate.normalized.includes(term))) {
        truncation.prunedByExclusion += 1;
        continue;
      }
      if (acceptedChildren >= input.policy.maxChildrenPerKeyword) {
        truncation.prunedByChildLimit += 1;
        continue;
      }

      let child = nodeByNormalized.get(candidate.normalized);
      if (!child) {
        if (nodes.length >= input.policy.maxKeywords) {
          truncation.hitKeywordLimit = true;
          continue;
        }
        const nextEstimate = (nodes.length + 1) * input.policy.noteDetailsPerKeyword;
        if (nextEstimate > input.policy.maxEstimatedNoteDetails) {
          truncation.hitNoteBudget = true;
          continue;
        }
        child = {
          keywordId: keywordId(candidate.normalized),
          value: candidate.value,
          normalized: candidate.normalized,
          depth: parent.depth + 1,
          source: "SUGGESTION",
          status: "QUEUED",
        };
        nodeByNormalized.set(candidate.normalized, child);
        nodes.push(child);
      }

      const edgeKey = `${parent.keywordId}>${child.keywordId}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({
          parentKeywordId: parent.keywordId,
          childKeywordId: child.keywordId,
          source: "SUGGESTION",
        });
        acceptedChildren += 1;
      }
    }
  }

  const plan: KeywordPlan = {
    schemaVersion: CONTRACT_VERSION,
    planId: input.planId,
    taskId: input.taskId,
    policy: {
      ...input.policy,
      excludedTerms: uniqueKeywords(input.policy.excludedTerms).map((item) => item.value),
    },
    nodes,
    edges,
    estimatedNoteDetails: nodes.length * input.policy.noteDetailsPerKeyword,
    truncation,
    createdAt: input.createdAt,
  };
  assertContract<KeywordPlan>("KeywordPlan", plan);
  return plan;
}
