import {
  inferReasoningConfig,
  resolveModelContextWindow,
  type ModelConfig,
  type Protocol,
  type ProviderConfig,
  type ProviderProbeResult,
  type ProviderProfile,
} from "../src/types";
import { networkFetch } from "./network";
import { normalizeProviderBaseUrl, providerApiEndpoint } from "./provider-url";

type ProviderWithKey = Omit<ProviderConfig, "hasApiKey"> & { apiKey: string };
type ProtocolFamily = ProviderProfile["protocolFamily"];

const PROBE_TIMEOUT_MS = 12_000;

function configuredFamily(protocol: Protocol): ProtocolFamily {
  if (protocol === "anthropic-messages") return "anthropic";
  if (protocol === "gemini-generate-content") return "gemini";
  return "openai";
}

function guessedFamily(baseUrl: string): ProtocolFamily | undefined {
  if (
    /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(
      baseUrl,
    )
  )
    return "gemini";
  if (/anthropic\.com/i.test(baseUrl)) return "anthropic";
  if (
    /openai\.com|openrouter\.ai|deepseek\.com|moonshot\.(?:cn|ai)|groq\.com|bigmodel\.cn|siliconflow\.(?:cn|com)|minimax/i.test(
      baseUrl,
    )
  )
    return "openai";
  return undefined;
}

function familyProtocol(family: ProtocolFamily): Protocol {
  if (family === "anthropic") return "anthropic-messages";
  if (family === "gemini") return "gemini-generate-content";
  return "openai-chat";
}

function protocolForFamily(family: ProtocolFamily): Protocol {
  return familyProtocol(family);
}

function candidates(provider: ProviderWithKey) {
  const configured = configuredFamily(provider.protocol);
  const guessed = guessedFamily(provider.baseUrl);
  return [
    ...new Set([guessed, configured, "openai", "anthropic", "gemini"]),
  ].filter((value): value is ProtocolFamily => Boolean(value));
}

function imageSupport(model: Record<string, unknown>) {
  const architecture =
    model.architecture && typeof model.architecture === "object"
      ? (model.architecture as Record<string, unknown>)
      : undefined;
  for (const value of [
    model.input_modalities,
    architecture?.input_modalities,
  ]) {
    if (Array.isArray(value))
      return value.some((item) =>
        /image|vision|multimodal/i.test(String(item)),
      );
  }
  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? (model.capabilities as Record<string, unknown>)
      : undefined;
  for (const key of ["vision", "image_input", "imageInput"])
    if (typeof capabilities?.[key] === "boolean")
      return capabilities[key] as boolean;
  return undefined;
}

function toolSupport(model: Record<string, unknown>) {
  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? (model.capabilities as Record<string, unknown>)
      : undefined;
  for (const key of [
    "tools",
    "tool_calling",
    "function_calling",
    "functionCalling",
  ])
    if (typeof capabilities?.[key] === "boolean")
      return capabilities[key] as boolean;
  return undefined;
}

function mapModels(
  provider: ProviderWithKey,
  family: ProtocolFamily,
  payload: unknown,
): ModelConfig[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const rawModels = family === "gemini" ? record.models : record.data;
  if (!Array.isArray(rawModels)) return undefined;
  const protocol =
    configuredFamily(provider.protocol) === family
      ? provider.protocol
      : familyProtocol(family);
  const models: ModelConfig[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== "object") continue;
    const model = item as Record<string, unknown>;
    const rawName = String(model.name ?? model.id ?? "");
    const modelId = rawName.replace(/^models\//, "");
    if (!modelId) continue;
    const inferred = inferReasoningConfig(modelId, protocol);
    const inputLimit = Number(model.inputTokenLimit ?? model.context_length);
    models.push({
      id: `${provider.id}:${modelId}`,
      modelId,
      displayName: String(model.displayName ?? model.display_name ?? modelId),
      protocol,
      supportsImages: imageSupport(model),
      supportsTools: toolSupport(model),
      contextWindow:
        Number.isFinite(inputLimit) && inputLimit > 0
          ? inputLimit
          : resolveModelContextWindow(modelId),
      ...inferred,
    });
  }
  return models;
}

function probeRequest(provider: ProviderWithKey, family: ProtocolFamily) {
  const protocol = protocolForFamily(family);
  const endpoint = providerApiEndpoint(provider.baseUrl, protocol, "models");
  if (family === "gemini") {
    const url = new URL(endpoint);
    url.searchParams.set("key", provider.apiKey);
    return { url: url.toString(), init: {} as RequestInit };
  }
  const headers: Record<string, string> =
    family === "anthropic"
      ? {
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { Authorization: `Bearer ${provider.apiKey}` };
  return { url: endpoint, init: { headers } as RequestInit };
}

function responseCapability(provider: ProviderWithKey, family: ProtocolFamily) {
  if (family !== "openai") return "unsupported" as const;
  if (/^https:\/\/api\.openai\.com(?:\/|$)/i.test(provider.baseUrl))
    return "supported" as const;
  return "unknown" as const;
}

export async function inspectProvider(
  provider: ProviderWithKey,
  fetchImpl: typeof fetch = networkFetch,
  now = Date.now,
): Promise<ProviderProbeResult> {
  const checkedAt = now();
  let lastError = "供应商没有返回可识别的模型列表";
  let lastLatency: number | undefined;
  let sawAuthError = false;
  let sawHttpResponse = false;

  for (const family of candidates(provider)) {
    const { url, init } = probeRequest(provider, family);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const startedAt = now();
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      lastLatency = Math.max(0, now() - startedAt);
      sawHttpResponse = true;
      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = undefined;
      }
      if (response.status === 401 || response.status === 403) {
        sawAuthError = true;
        lastError = `认证失败 (${response.status})`;
        continue;
      }
      if (!response.ok) {
        lastError = `模型列表接口返回 ${response.status}${text ? `：${text.slice(0, 160)}` : ""}`;
        continue;
      }
      const models = mapModels(provider, family, payload);
      const normalizedBaseUrl = normalizeProviderBaseUrl(
        provider.baseUrl,
        provider.protocol,
      );
      const profile: ProviderProfile = {
        checkedAt,
        status: models ? "healthy" : "degraded",
        protocolFamily: family,
        normalizedBaseUrl,
        latencyMs: lastLatency,
        supportsModelListing: Boolean(models),
        supportsResponses: responseCapability(provider, family),
        streamMode: "auto",
        message: models
          ? `连接正常，发现 ${models.length} 个模型`
          : "连接正常，但模型列表格式无法识别",
      };
      const configured = configuredFamily(provider.protocol);
      return {
        profile,
        models: models ?? [],
        ...(configured !== family
          ? { suggestedProtocol: familyProtocol(family) }
          : {}),
      };
    } catch (error) {
      lastLatency = Math.max(0, now() - startedAt);
      lastError =
        error instanceof DOMException && error.name === "AbortError"
          ? `连接检测超过 ${PROBE_TIMEOUT_MS / 1_000} 秒`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  const family = configuredFamily(provider.protocol);
  return {
    profile: {
      checkedAt,
      status: sawAuthError
        ? "auth-error"
        : sawHttpResponse
          ? "degraded"
          : "unreachable",
      protocolFamily: family,
      normalizedBaseUrl: normalizeProviderBaseUrl(
        provider.baseUrl,
        provider.protocol,
      ),
      latencyMs: lastLatency,
      supportsModelListing: false,
      supportsResponses: responseCapability(provider, family),
      message: lastError,
    },
    models: [],
  };
}
