import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../src/types";
import { inspectProvider } from "./provider-profile";

function provider(overrides: Partial<ProviderConfig> = {}) {
  return {
    id: "provider-1",
    name: "Provider",
    baseUrl: "https://provider.example/api/v1",
    protocol: "openai-chat" as const,
    enabled: true,
    models: [],
    apiKey: "secret",
    ...overrides,
  };
}

test("probes an OpenAI-compatible model endpoint and preserves gateway prefixes", async () => {
  const calls: string[] = [];
  const result = await inspectProvider(provider(), (async (
    url: string | URL | Request,
  ) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "model-a",
            input_modalities: ["text", "image"],
            capabilities: { tools: true },
          },
        ],
      }),
    );
  }) as typeof fetch);
  assert.deepEqual(calls, ["https://provider.example/api/v1/models"]);
  assert.equal(result.profile.status, "healthy");
  assert.equal(
    result.profile.normalizedBaseUrl,
    "https://provider.example/api",
  );
  assert.equal(result.models[0].supportsImages, true);
  assert.equal(result.models[0].supportsTools, true);
});

test("prefers a protocol suggested by a known Gemini URL", async () => {
  const result = await inspectProvider(
    provider({ baseUrl: "https://generativelanguage.googleapis.com" }),
    (async (url: string | URL | Request) => {
      assert.match(String(url), /v1beta\/models\?key=secret/);
      return new Response(
        JSON.stringify({ models: [{ name: "models/gemini-test" }] }),
      );
    }) as typeof fetch,
  );
  assert.equal(result.profile.protocolFamily, "gemini");
  assert.equal(result.suggestedProtocol, "gemini-generate-content");
  assert.equal(result.models[0].modelId, "gemini-test");
});

test("reports authentication failures without treating them as stream errors", async () => {
  const result = await inspectProvider(
    provider(),
    (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
  );
  assert.equal(result.profile.status, "auth-error");
  assert.match(result.profile.message ?? "", /认证失败/);
});
