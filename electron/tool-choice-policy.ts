import type { Protocol } from "../src/types";

export function requiredToolChoiceForProtocol(
  protocol: Protocol,
  options: { anthropicThinkingEnabled?: boolean } = {},
): Record<string, unknown> {
  if (protocol === "openai-chat" || protocol === "openai-responses")
    return { tool_choice: "required" };
  if (protocol === "anthropic-messages")
    return options.anthropicThinkingEnabled
      ? {}
      : { tool_choice: { type: "any" } };
  return {
    toolConfig: {
      functionCallingConfig: { mode: "ANY" },
    },
  };
}
