import { inferReasoningConfig } from "../types";
import type {
  ModelConfig,
  PermissionMode,
  PermissionPolicy,
  ProviderConfig,
  ReasoningEffort,
} from "../types";

export const effortLabels: Record<ReasoningEffort, string> = {
  auto: "自动",
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  thinking: "思考",
};

export const savedEfforts: ReasoningEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
];

export const policyForMode = (mode: PermissionMode): PermissionPolicy =>
  Object.fromEntries(
    [
      "workspaceWrite",
      "deletePaths",
      "runCommands",
      "longRunningProcesses",
      "network",
      "gitPublish",
    ].map((key) => [
      key,
      mode === "full-access"
        ? "allow"
        : mode === "read-only"
          ? "deny"
          : "confirm",
    ]),
  ) as PermissionPolicy;

export function reasoningEffortsForModel(model?: ModelConfig): ReasoningEffort[] {
  if (!model) return ["auto"];
  return model.reasoningEfforts?.length
    ? model.reasoningEfforts
    : (inferReasoningConfig(model.modelId, model.protocol).reasoningEfforts ?? [
        "auto",
      ]);
}

export function normalizeEffort(
  effort: ReasoningEffort,
  supported: ReasoningEffort[],
): ReasoningEffort {
  if (supported.includes(effort)) return effort;
  if (effort === "max" && supported.includes("xhigh")) return "xhigh";
  if (supported.includes("medium")) return "medium";
  return supported[0] ?? "auto";
}

export const previewProviders: ProviderConfig[] = [
  {
    id: "preview-openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    protocol: "openai-responses",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-openai:gpt",
        modelId: "gpt-5",
        displayName: "GPT-5",
        protocol: "openai-responses",
      },
      {
        id: "preview-openai:gpt-5.5",
        modelId: "gpt-5.5",
        displayName: "GPT-5.5",
        protocol: "openai-responses",
      },
      {
        id: "preview-openai:gpt-5.6-sol",
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        protocol: "openai-responses",
      },
    ],
  },
  {
    id: "preview-anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-anthropic:claude",
        modelId: "claude-sonnet",
        displayName: "Claude Sonnet",
        protocol: "anthropic-messages",
      },
    ],
  },
  {
    id: "preview-chat",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    protocol: "openai-chat",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "preview-chat:deepseek",
        modelId: "deepseek/deepseek-chat-v3",
        displayName: "DeepSeek Chat V3",
        protocol: "openai-chat",
      },
    ],
  },
];
