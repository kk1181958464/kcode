import test from "node:test";
import assert from "node:assert/strict";
import {
  clearProtocolFallbacks,
  effectiveOpenAiProtocol,
  rememberChatFallback,
  shouldFallbackResponses,
} from "./protocol-fallback";

test("falls back only for unavailable third-party Responses endpoints", () => {
  assert.equal(shouldFallbackResponses("https://proxy.example", 502), true);
  assert.equal(shouldFallbackResponses("https://proxy.example/v1", 404), true);
  assert.equal(shouldFallbackResponses("https://proxy.example", 401), false);
  assert.equal(shouldFallbackResponses("https://proxy.example", 429), false);
  assert.equal(shouldFallbackResponses("https://api.openai.com", 502), false);
});

test("falls back for an explicit third-party Responses tool-history incompatibility", () => {
  const error =
    "The function_call_output in the thinking mode requires item_reference ids";
  assert.equal(
    shouldFallbackResponses("https://proxy.example/v1", 400, error),
    true,
  );
  assert.equal(
    shouldFallbackResponses("https://proxy.example/v1", 422, error),
    true,
  );
  assert.equal(
    shouldFallbackResponses(
      "https://proxy.example/v1",
      400,
      "Invalid reasoning effort",
    ),
    false,
  );
  assert.equal(
    shouldFallbackResponses("https://api.openai.com", 400, error),
    false,
  );
});

test("remembers a provider's Chat Completions fallback temporarily", () => {
  clearProtocolFallbacks();
  rememberChatFallback("proxy", 1_000);
  assert.equal(
    effectiveOpenAiProtocol("proxy", "openai-responses", 2_000),
    "openai-chat",
  );
  assert.equal(
    effectiveOpenAiProtocol("proxy", "openai-responses", 31 * 60_000),
    "openai-responses",
  );
  assert.equal(
    effectiveOpenAiProtocol("proxy", "anthropic-messages"),
    "anthropic-messages",
  );
});

test("keeps a Responses fallback scoped to the incompatible model", () => {
  clearProtocolFallbacks();
  rememberChatFallback("proxy", "model-a", 1_000);
  assert.equal(
    effectiveOpenAiProtocol("proxy", "openai-responses", "model-a", 2_000),
    "openai-chat",
  );
  assert.equal(
    effectiveOpenAiProtocol("proxy", "openai-responses", "model-b", 2_000),
    "openai-responses",
  );
});
