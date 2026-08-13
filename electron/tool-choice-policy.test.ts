import assert from "node:assert/strict";
import test from "node:test";
import { requiredToolChoiceForProtocol } from "./tool-choice-policy";

test("maps required native tool selection to each provider protocol", () => {
  assert.deepEqual(requiredToolChoiceForProtocol("openai-chat"), {
    tool_choice: "required",
  });
  assert.deepEqual(requiredToolChoiceForProtocol("openai-responses"), {
    tool_choice: "required",
  });
  assert.deepEqual(requiredToolChoiceForProtocol("anthropic-messages"), {
    tool_choice: { type: "any" },
  });
  assert.deepEqual(requiredToolChoiceForProtocol("gemini-generate-content"), {
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
  });
});

test("uses the runtime instruction instead of unsupported Anthropic forcing while thinking", () => {
  assert.deepEqual(
    requiredToolChoiceForProtocol("anthropic-messages", {
      anthropicThinkingEnabled: true,
    }),
    {},
  );
});
