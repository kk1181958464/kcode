import type { ModelConfig, Protocol, ProviderConfig } from "../src/types";

export type ModelCompatibility = {
  streamMode: "delta" | "cumulative" | "auto";
  splitReasoning: boolean;
};

export function resolveModelCompatibility(
  provider: Pick<ProviderConfig, "baseUrl" | "profile">,
  model: Pick<ModelConfig, "modelId" | "streamMode">,
  protocol: Protocol,
): ModelCompatibility {
  const knownCumulative =
    protocol === "openai-chat" &&
    /(?:^|[/:])glm(?:[-_.]|$)/i.test(model.modelId);
  return {
    streamMode:
      model.streamMode ??
      (knownCumulative
        ? "cumulative"
        : (provider.profile?.streamMode ??
          (protocol === "openai-chat" ? "auto" : "delta"))),
    splitReasoning:
      protocol === "openai-chat" &&
      /api\.minimaxi?\.com/i.test(provider.baseUrl),
  };
}
