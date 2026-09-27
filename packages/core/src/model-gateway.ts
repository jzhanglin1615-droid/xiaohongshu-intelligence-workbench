import { createHash } from "node:crypto";

export type ModelTask = "EXTRACT" | "SCREEN" | "DEEP_ANALYSIS" | "VERIFY" | "DECISION_SUPPORT";

export interface ModelProviderConfig {
  providerId: string;
  label: string;
  protocol: "OPENAI_COMPATIBLE";
  baseUrl: string;
  apiKeyEnv: string;
  enabled: boolean;
  modelsPath?: string;
  chatPath?: string;
  timeoutMs?: number;
}

export interface ModelRoute {
  task: ModelTask;
  providerId: string;
  modelId: string;
  fallbackProviderIds: string[];
}

export interface ModelCatalogEntry {
  id: string;
  ownedBy: string | null;
}

export interface ModelCallReceipt {
  providerId: string;
  modelId: string;
  task: ModelTask;
  startedAt: string;
  finishedAt: string;
  status: "SUCCEEDED" | "FAILED";
  inputSha256: string;
  outputSha256: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  errorCode: string | null;
}

export interface ModelAnalysisResult {
  content: string;
  parsedJson: unknown | null;
  receipt: ModelCallReceipt;
}

type FetchLike = typeof fetch;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function validateProvider(config: ModelProviderConfig): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(config.providerId)) throw new Error("INVALID_PROVIDER_ID");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv)) throw new Error("INVALID_API_KEY_ENV");
  const url = new URL(config.baseUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("INSECURE_PROVIDER_URL");
  if (!config.enabled) throw new Error("PROVIDER_DISABLED");
}

function endpoint(config: ModelProviderConfig, relativePath: string): string {
  const root = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  return new URL(relativePath.replace(/^\/+/, ""), root).toString();
}

function readKey(config: ModelProviderConfig, environment: Record<string, string | undefined>): string {
  const key = environment[config.apiKeyEnv]?.trim();
  if (!key) throw new Error(`API_KEY_NOT_CONFIGURED:${config.apiKeyEnv}`);
  return key;
}

export class OpenAICompatibleModelGateway {
  private readonly fetcher: FetchLike;
  private readonly environment: Record<string, string | undefined>;
  private readonly now: () => string;

  constructor(
    fetcher: FetchLike = fetch,
    environment: Record<string, string | undefined> = process.env,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.fetcher = fetcher;
    this.environment = environment;
    this.now = now;
  }

  async listModels(config: ModelProviderConfig): Promise<ModelCatalogEntry[]> {
    validateProvider(config);
    const key = readKey(config, this.environment);
    const response = await this.fetcher(endpoint(config, config.modelsPath ?? "models"), {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`MODEL_LIST_HTTP_${response.status}`);
    const payload = await response.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    if (!Array.isArray(payload.data)) throw new Error("INVALID_MODEL_LIST_RESPONSE");
    return payload.data
      .filter((item): item is { id: string; owned_by?: unknown } => typeof item.id === "string" && item.id.length > 0)
      .map((item) => ({ id: item.id, ownedBy: typeof item.owned_by === "string" ? item.owned_by : null }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async analyze(input: {
    config: ModelProviderConfig;
    task: ModelTask;
    modelId: string;
    systemPrompt: string;
    evidencePacket: unknown;
    requireJson?: boolean;
  }): Promise<ModelAnalysisResult> {
    validateProvider(input.config);
    if (!input.modelId.trim()) throw new Error("MODEL_NOT_SELECTED");
    const key = readKey(input.config, this.environment);
    const startedAt = this.now();
    const serializedEvidence = JSON.stringify(input.evidencePacket);
    const inputHash = sha256(`${input.systemPrompt}\n${serializedEvidence}`);
    try {
      const response = await this.fetcher(endpoint(input.config, input.config.chatPath ?? "chat/completions"), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: input.modelId,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: serializedEvidence },
          ],
          ...(input.requireJson ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(input.config.timeoutMs ?? 60_000),
      });
      if (!response.ok) throw new Error(`MODEL_CALL_HTTP_${response.status}`);
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) throw new Error("INVALID_MODEL_RESPONSE");
      let parsedJson: unknown | null = null;
      if (input.requireJson) {
        try { parsedJson = JSON.parse(content); } catch { throw new Error("INVALID_MODEL_JSON"); }
      }
      return {
        content,
        parsedJson,
        receipt: {
          providerId: input.config.providerId,
          modelId: input.modelId,
          task: input.task,
          startedAt,
          finishedAt: this.now(),
          status: "SUCCEEDED",
          inputSha256: inputHash,
          outputSha256: sha256(content),
          usage: {
            inputTokens: typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : null,
            outputTokens: typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : null,
            totalTokens: typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : null,
          },
          errorCode: null,
        },
      };
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0] : "MODEL_CALL_FAILED";
      const failure = new Error(code) as Error & { receipt?: ModelCallReceipt };
      failure.receipt = {
        providerId: input.config.providerId,
        modelId: input.modelId,
        task: input.task,
        startedAt,
        finishedAt: this.now(),
        status: "FAILED",
        inputSha256: inputHash,
        outputSha256: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        errorCode: code,
      };
      throw failure;
    }
  }
}

export function publicProviderState(config: ModelProviderConfig, environment: Record<string, string | undefined> = process.env) {
  return {
    ...config,
    apiKeyConfigured: Boolean(environment[config.apiKeyEnv]?.trim()),
  };
}
