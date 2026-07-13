import { app, safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferContextWindow, type ProviderConfig } from "../src/types";

type StoredProvider = Omit<ProviderConfig, "hasApiKey"> & {
  encryptedApiKey?: string;
};
type LegacyProtocol = ProviderConfig["protocol"] | "openai" | "anthropic";

const defaults: StoredProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com",
    enabled: false,
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    enabled: false,
    models: [],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    enabled: false,
    models: [],
  },
];

function filePath() {
  return path.join(app.getPath("userData"), "providers.json");
}

async function readStored(): Promise<StoredProvider[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath(), "utf8")) as Array<
      Omit<StoredProvider, "protocol"> & { protocol: LegacyProtocol }
    >;
    return parsed.map((provider) => {
      const protocol =
        provider.protocol === "openai"
          ? "openai-chat"
          : provider.protocol === "anthropic"
            ? "anthropic-messages"
            : provider.protocol;
      return {
        ...provider,
        protocol,
        models: provider.models.map((model) => ({ ...model, protocol })),
      };
    });
  } catch {
    return defaults;
  }
}

async function writeStored(data: StoredProvider[]) {
  await mkdir(path.dirname(filePath()), { recursive: true });
  await writeFile(filePath(), JSON.stringify(data, null, 2), "utf8");
}

function publicProvider(provider: StoredProvider): ProviderConfig {
  const { encryptedApiKey, ...rest } = provider;
  return { ...rest, hasApiKey: Boolean(encryptedApiKey) };
}

export async function listProviders() {
  const stored = await readStored();
  const migrated = stored.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      const inferred = inferContextWindow(model.modelId);
      return model.contextWindow === 128_000 && inferred && inferred !== 128_000 && /^(glm-5\.1|glm-5\.2|deepseek-v4-(?:pro|flash))$/i.test(model.modelId)
        ? { ...model, contextWindow: inferred }
        : model;
    }),
  }));
  if (JSON.stringify(migrated) !== JSON.stringify(stored)) await writeStored(migrated);
  return migrated.map(publicProvider);
}

export async function saveProvider(provider: ProviderConfig, apiKey?: string) {
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
  } catch {
    throw new Error("Base URL 格式无效");
  }
  const localHost =
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "::1";
  if (
    baseUrl.protocol !== "https:" &&
    !(localHost && baseUrl.protocol === "http:")
  )
    throw new Error("Base URL 必须使用 HTTPS，本机服务可使用 HTTP");
  const all = await readStored();
  const previousIndex = all.findIndex((item) => item.id === provider.id);
  const previous = previousIndex >= 0 ? all[previousIndex] : undefined;
  const endpointChanged = Boolean(
    previous &&
    (previous.baseUrl !== provider.baseUrl ||
      previous.protocol !== provider.protocol),
  );
  if (endpointChanged && !apiKey)
    throw new Error("接口地址或协议已变化，请重新输入 API Key");
  const encryptedApiKey = apiKey
    ? safeStorage.encryptString(apiKey).toString("base64")
    : endpointChanged
      ? undefined
      : previous?.encryptedApiKey;
  const stored: StoredProvider = { ...provider, encryptedApiKey };
  delete (stored as Partial<ProviderConfig>).hasApiKey;
  const next = [...all];
  if (previousIndex >= 0) next[previousIndex] = stored;
  else next.push(stored);
  await writeStored(next);
  return next.map(publicProvider);
}

export async function removeProvider(id: string) {
  const next = (await readStored()).filter((item) => item.id !== id);
  await writeStored(next);
  return next.map(publicProvider);
}

export async function getProviderWithKey(id: string) {
  const provider = (await readStored()).find((item) => item.id === id);
  if (!provider) throw new Error("供应商不存在");
  if (!provider.encryptedApiKey) throw new Error("请先配置 API Key");
  return {
    ...provider,
    apiKey: safeStorage.decryptString(
      Buffer.from(provider.encryptedApiKey, "base64"),
    ),
  };
}
