import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderId,
  defaultFirst,
  firstUsableSelection,
  isUsableProvider,
} from "../cli/providers";
import type { ModelConfig, ProviderConfig } from "../src/types";

const models: ModelConfig[] = [
  { id: "p:a", modelId: "a", displayName: "A", protocol: "openai-chat" },
  { id: "p:b", modelId: "b", displayName: "B", protocol: "openai-chat" },
];

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "p",
  name: "Provider",
  baseUrl: "https://example.com",
  protocol: "openai-chat",
  enabled: true,
  hasApiKey: true,
  models,
  ...overrides,
});

test("CLI provider helpers identify usable channels", () => {
  assert.equal(isUsableProvider(provider()), true);
  assert.equal(isUsableProvider(provider({ enabled: false })), false);
  assert.equal(isUsableProvider(provider({ hasApiKey: false })), false);
  assert.equal(isUsableProvider(provider({ models: [] })), false);
});

test("CLI provider ids are readable and collision resistant", () => {
  assert.equal(createProviderId("My OpenAI Relay", []), "my-openai-relay");
  assert.match(
    createProviderId("My OpenAI Relay", ["my-openai-relay"]),
    /^my-openai-relay-[a-f0-9]{8}$/,
  );
});

test("CLI keeps the selected default model first", () => {
  assert.deepEqual(
    defaultFirst(models, "b").map((model) => model.modelId),
    ["b", "a"],
  );
  assert.deepEqual(
    defaultFirst(models, "missing").map((model) => model.modelId),
    ["a", "b"],
  );
});

test("CLI falls back to the first usable provider after channel changes", () => {
  const selection = firstUsableSelection([
    provider({ id: "disabled", enabled: false }),
    provider({ id: "ready", name: "Ready" }),
  ]);
  assert.equal(selection?.provider.id, "ready");
  assert.equal(selection?.modelId, "a");
});
