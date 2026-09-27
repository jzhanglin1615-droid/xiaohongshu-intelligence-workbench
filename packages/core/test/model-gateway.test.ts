import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAICompatibleModelGateway, publicProviderState, type ModelProviderConfig } from "../src/model-gateway.ts";

async function withFakeProvider(run: (config: ModelProviderConfig, requests: Array<{ url: string; auth: string | undefined; body: string }>) => Promise<void>) {
  const requests: Array<{ url: string; auth: string | undefined; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", auth: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "model-b", owned_by: "fake" }, { id: "model-a" }] }));
      else response.end(JSON.stringify({ choices: [{ message: { content: "{\"verdict\":\"supported\"}" } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const config: ModelProviderConfig = { providerId: "fake", label: "Fake", protocol: "OPENAI_COMPATIBLE", baseUrl: `http://127.0.0.1:${address.port}/v1/`, apiKeyEnv: "FAKE_API_KEY", enabled: true };
  try { await run(config, requests); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("model catalog is pulled from an OpenAI-compatible endpoint and sorted", async () => {
  await withFakeProvider(async (config, requests) => {
    const gateway = new OpenAICompatibleModelGateway(fetch, { FAKE_API_KEY: "secret-value" });
    assert.deepEqual(await gateway.listModels(config), [{ id: "model-a", ownedBy: null }, { id: "model-b", ownedBy: "fake" }]);
    assert.equal(requests[0].url, "/v1/models");
    assert.equal(requests[0].auth, "Bearer secret-value");
  });
});

test("analysis calls the selected model and emits an auditable receipt without the key", async () => {
  await withFakeProvider(async (config, requests) => {
    const gateway = new OpenAICompatibleModelGateway(fetch, { FAKE_API_KEY: "secret-value" }, () => "2026-09-25T04:00:00.000Z");
    const result = await gateway.analyze({ config, task: "DEEP_ANALYSIS", modelId: "model-a", systemPrompt: "Only use evidence", evidencePacket: { noteId: "note-001" }, requireJson: true });
    assert.deepEqual(result.parsedJson, { verdict: "supported" });
    assert.equal(result.receipt.status, "SUCCEEDED");
    assert.equal(result.receipt.usage.totalTokens, 17);
    assert(!JSON.stringify(result).includes("secret-value"));
    assert.equal(JSON.parse(requests[0].body).model, "model-a");
  });
});

test("missing keys and disabled providers fail before network access", async () => {
  const gateway = new OpenAICompatibleModelGateway(async () => { throw new Error("network should not run"); }, {});
  const base: ModelProviderConfig = { providerId: "safe", label: "Safe", protocol: "OPENAI_COMPATIBLE", baseUrl: "https://example.com/v1/", apiKeyEnv: "SAFE_API_KEY", enabled: true };
  await assert.rejects(() => gateway.listModels(base), /API_KEY_NOT_CONFIGURED/);
  await assert.rejects(() => gateway.listModels({ ...base, enabled: false }), /PROVIDER_DISABLED/);
});

test("public provider state exposes only key presence, never key material", () => {
  const config: ModelProviderConfig = { providerId: "safe", label: "Safe", protocol: "OPENAI_COMPATIBLE", baseUrl: "https://example.com/v1/", apiKeyEnv: "SAFE_API_KEY", enabled: true };
  const state = publicProviderState(config, { SAFE_API_KEY: "top-secret" });
  assert.equal(state.apiKeyConfigured, true);
  assert(!JSON.stringify(state).includes("top-secret"));
});
