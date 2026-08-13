import { randomUUID } from "node:crypto";
import type { ModelConfig, ProviderConfig } from "../src/types";

export function isUsableProvider(provider: ProviderConfig): boolean {
  return provider.enabled && provider.hasApiKey && provider.models.length > 0;
}

export function createProviderId(
  name: string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const base = slug || "provider";
  if (!used.has(base)) return base;
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export function defaultFirst(
  models: ModelConfig[],
  defaultModelId: string,
): ModelConfig[] {
  const selected = models.find((model) => model.modelId === defaultModelId);
  if (!selected) return [...models];
  return [
    selected,
    ...models.filter((model) => model.modelId !== defaultModelId),
  ];
}

export function firstUsableSelection(
  providers: ProviderConfig[],
): { provider: ProviderConfig; modelId: string } | undefined {
  const provider = providers.find(isUsableProvider);
  const modelId = provider?.models[0]?.modelId;
  return provider && modelId ? { provider, modelId } : undefined;
}
