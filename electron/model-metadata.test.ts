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
