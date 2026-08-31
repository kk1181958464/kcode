import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveRuntimePromptTokens,
  estimateRuntimeHistoryTokens,
  RUNTIME_PROMPT_OVERHEAD_TOKENS,
} from "./runtime-context-budget";

test("estimates runtime history from serialized model-visible items", () => {
  const history = [
    { kind: "message", role: "user", content: "检查项目" },
    { kind: "result", callId: "read-1", content: "x".repeat(900) },
  ];
  assert.ok(estimateRuntimeHistoryTokens(history) >= 300);
  assert.equal(
    effectiveRuntimePromptTokens(history),
    estimateRuntimeHistoryTokens(history) + RUNTIME_PROMPT_OVERHEAD_TOKENS,
  );
});

test("keeps a provider-reported prompt count as a conservative floor", () => {
  const reported = 250_000;
  assert.equal(effectiveRuntimePromptTokens([], reported), reported);
});
