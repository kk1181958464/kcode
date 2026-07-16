import assert from "node:assert/strict";
import test from "node:test";
import { inferContextWindow, inferReasoningConfig } from "../src/types";

test("uses current OpenAI context windows for exact GPT model IDs", () => {
  assert.equal(inferContextWindow("gpt-5.5"), 258_400);
  assert.equal(inferContextWindow("gpt-5.4"), 258_400);
  assert.equal(inferContextWindow("gpt-5.6"), 353_400);
  assert.equal(inferContextWindow("gpt-5.6-sol"), 353_400);
  assert.equal(inferContextWindow("gpt-5.6-sol-custom"), undefined);
});

test("keeps provider context windows separate from Codex task budgets", () => {
  assert.equal(inferContextWindow("deepseek-chat"), 1_000_000);
  assert.equal(inferContextWindow("deepseek-reasoner"), 1_000_000);
  assert.equal(inferContextWindow("kimi-k2.7-code"), 262_144);
  assert.equal(inferContextWindow("MiniMax-M3"), 1_000_000);
  assert.equal(inferContextWindow("MiniMax-M2.7"), 204_800);
  assert.equal(inferContextWindow("glm-5.1"), 200_000);
  assert.equal(inferContextWindow("glm-5.2"), 1_000_000);
  assert.equal(inferContextWindow("deepseek-v4-flash"), 1_000_000);
  assert.equal(inferContextWindow("deepseek-v4-pro"), 1_000_000);
});

test("offers max reasoning for the GPT-5.6 family", () => {
  assert.deepEqual(
    inferReasoningConfig("gpt-5.6-sol", "openai-responses").reasoningEfforts,
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("recognizes Grok reasoning models and context windows", () => {
  assert.deepEqual(
    inferReasoningConfig("grok-4.5", "openai-chat"),
    {
      reasoningMode: "effort",
      reasoningEfforts: ["low", "medium", "high"],
    },
  );
  assert.deepEqual(
    inferReasoningConfig("grok-3-mini", "openai-chat"),
    {
      reasoningMode: "effort",
      reasoningEfforts: ["low", "medium", "high"],
    },
  );
  assert.equal(inferReasoningConfig("grok-3", "openai-chat").reasoningMode, "none");
  assert.equal(inferContextWindow("grok-4.5"), 500_000);
  assert.equal(inferContextWindow("grok-4.5-latest"), 500_000);
  assert.equal(inferContextWindow("grok-build-latest"), 500_000);
  assert.equal(
    inferReasoningConfig("grok-build-latest", "openai-chat").reasoningMode,
    "effort",
  );
  assert.equal(inferContextWindow("grok-4"), 256_000);
  assert.equal(inferContextWindow("grok-3-mini"), 131_072);
  assert.equal(inferContextWindow("grok-3"), 131_072);
});
