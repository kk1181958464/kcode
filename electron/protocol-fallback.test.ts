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