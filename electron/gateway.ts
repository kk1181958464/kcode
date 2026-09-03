import {
  inferReasoningConfig,
  type ContextLedger,
  type ContextSummaryRequest,
  type ContextSummaryResult,
  type ModelConfig,
  type ModelEvent,
  type ModelRequest,
} from "../src/types";
import {
  parseAnthropicMessagesEvent,
  parseChatCompletionsEvent,
  parseResponsesEvent,
} from "./protocols";
import { getProviderWithKey, updateProviderProfile } from "./store";
import { networkFetch } from "./network";
import { inspectProvider } from "./provider-profile";
import { providerApiEndpoint } from "./provider-url";
import { redactSensitiveText } from "../src/context";
import { selectCheapModel, HANDOFF_SYSTEM_PROMPT } from "./handoff-prompt";
import { effectiveOpenAiProtocol } from "./protocol-fallback";
import { fetchWithRetry, readResponseText } from "./request-guard";

const trim = (url: string) => url.replace(/\/+$/, "");
const apiEndpoint = (baseUrl: string, resource: string) =>
  providerApiEndpoint(baseUrl, "openai-chat", resource);

async function checkedFetch(url: string, init: RequestInit) {
  const response = await networkFetch(url, init);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `请求失败 (${response.status}): ${detail || response.statusText}`,
    );
  }
  return response;
}

const summaryControllers = new Map<string, AbortController>();
export type ProviderWithKey = Awaited<ReturnType<typeof getProviderWithKey>>;

type ContextSummaryOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function summaryModelForProvider(
  provider: ProviderWithKey,
  taskModelId: string,
  protocol = provider.protocol,
) {
  const preferred = selectCheapModel(protocol, taskModelId);
  // A preset cheap model is only useful when this provider actually exposes
  // it. Custom gateways often use the same protocol but publish a different
  // model list, so fall back to the selected task model instead of sending an
  // invalid model id and silently losing model-generated compaction.
  return provider.models.some((model) => model.modelId === preferred)
    ? preferred
    : taskModelId;
}

function linkedSummarySignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export function cancelContextSummary(taskId: string) {
  summaryControllers.get(taskId)?.abort();
  summaryControllers.delete(taskId);
}

function modelContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(modelContentText).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  if (typeof item.text === "string") return item.text;
  if (typeof item.output_text === "string") return item.output_text;
  if (item.content !== undefined) return modelContentText(item.content);
  return "";
}

function responseTextForProtocol(json: any, protocol: string) {
  if (protocol === "openai-chat")
    return modelContentText(json.choices?.[0]?.message?.content);
  if (protocol === "openai-responses")
    return modelContentText(
      json.output_text ??
        json.output?.flatMap((item: any) => item.content ?? []),
    );
  if (protocol === "anthropic-messages") return modelContentText(json.content);
  return modelContentText(json.candidates?.[0]?.content?.parts);
}

function parseJsonObject(text: string) {
  const source = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("模型未返回 JSON 摘要");
}
const parseSummary = (
  text: string,
  fallback: ContextLedger,
  durationMs: number,
  modelId?: string,
  usage?: { input: number; output: number },
): ContextSummaryResult => {
  const value = parseJsonObject(text) as {
    summary?: unknown;
    ledger?: Partial<Record<keyof ContextLedger, unknown>>;
  };
  if (typeof value.summary !== "string" || !value.summary.trim())
    throw new Error("模型摘要为空");
  const list = (key: keyof ContextLedger) => {
    const generated = Array.isArray(value.ledger?.[key])
      ? (value.ledger![key] as unknown[]).filter(
          (item): item is string =>
            typeof item === "string" && Boolean(item.trim()),
        )
      : [];
    return [
      ...new Set(
        [...(fallback[key] ?? []), ...generated]
          .map((item) => redactSensitiveText(item).trim())
          .filter(Boolean),
      ),
    ].slice(-64);
  };
  // Execution facts are owned by the runtime event ledger. A summarizer may
  // condense semantic conversation state, but cannot invent tool outcomes.
  return {
    summary: redactSensitiveText(value.summary).slice(0, 40_000),
    ledger: {
      goals: list("goals"),
      decisions: list("decisions"),
      changedFiles: fallback.changedFiles ?? [],
      validations: fallback.validations ?? [],
      failures: fallback.failures ?? [],
      pending: list("pending"),
      connections: fallback.connections ?? [],
    },
    modelGenerated: true,
    durationMs,
    modelId,
    usage,
  };
};

export async function summarizeContextWithProvider(
  request: ContextSummaryRequest,
  provider: ProviderWithKey,
  options: ContextSummaryOptions = {},
): Promise<ContextSummaryResult> {
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  )!;
  const summaryProtocol =
    provider.protocol === "openai-responses" &&
    (selectedModel.supportsResponses === false ||
      effectiveOpenAiProtocol(provider.id, provider.protocol, request.modelId) ===
        "openai-chat")
      ? "openai-chat"
      : provider.protocol;
  const summaryModel = summaryModelForProvider(
    provider,
    request.modelId,
    summaryProtocol,
  );
  const linked = linkedSummarySignal(options.signal, options.timeoutMs ?? 60_000);
  const startedAt = Date.now();
  // Callers already pack the source against the selected model's context
  // budget. Do not apply the old fixed 120k slice again here: it would discard
  // the middle of a long runtime transcript immediately before the model sees
  // it.
  const historySource = request.source;
  const prompt = `${HANDOFF_SYSTEM_PROMPT}

Existing ledger:
${JSON.stringify(request.ledger)}

History:
${historySource}`;
  try {
    let url = "",
      headers: Record<string, string> = { "Content-Type": "application/json" },
      body: Record<string, unknown>;
    if (summaryProtocol === "openai-chat") {
      url = apiEndpoint(provider.baseUrl, "chat/completions");
      headers.Authorization = `Bearer ${provider.apiKey}`;
      body = {
        model: summaryModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        stream: false,
      };
    } else if (summaryProtocol === "openai-responses") {
      url = apiEndpoint(provider.baseUrl, "responses");
      headers.Authorization = `Bearer ${provider.apiKey}`;
      body = { model: summaryModel, input: prompt, max_output_tokens: 4000 };
    } else if (summaryProtocol === "anthropic-messages") {
      url = apiEndpoint(provider.baseUrl, "messages");
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: summaryModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
      };
    } else {
      url = `${providerApiEndpoint(provider.baseUrl, summaryProtocol, `models/${encodeURIComponent(summaryModel)}:generateContent`)}?key=${encodeURIComponent(provider.apiKey)}`;
      body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4000,
          responseMimeType: "application/json",
        },
      };
    }
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      {
        signal: linked.signal,
        firstByteTimeoutMs: Math.min(
          30_000,
          options.timeoutMs ?? 60_000,
        ),
        retries: 1,
        retryDelayMs: 750,
        maxBackoffMs: 4_000,
        fetchImpl: networkFetch,
      },
    );
    if (!response.ok) {
      const detail = await readResponseText(
        response,
        linked.signal,
        5_000,
        5_000,
      ).catch(() => "");
      throw new Error(
        `请求失败 (${response.status}): ${detail.slice(0, 500) || response.statusText}`,
      );
    }
    const responseBody = await readResponseText(
      response,
      linked.signal,
      15_000,
      options.timeoutMs ?? 60_000,
    );
    const json = JSON.parse(responseBody) as any;
    const text = responseTextForProtocol(json, summaryProtocol);
    const usage =
      summaryProtocol === "openai-chat"
        ? {
            input: json.usage?.prompt_tokens ?? 0,
            output: json.usage?.completion_tokens ?? 0,
          }
        : summaryProtocol === "openai-responses"
          ? {
              input: json.usage?.input_tokens ?? 0,
              output: json.usage?.output_tokens ?? 0,
            }
          : summaryProtocol === "anthropic-messages"
            ? {
                input: json.usage?.input_tokens ?? 0,
                output: json.usage?.output_tokens ?? 0,
              }
            : {
                input: json.usageMetadata?.promptTokenCount ?? 0,
                output: json.usageMetadata?.candidatesTokenCount ?? 0,
              };
    const result = parseSummary(
      String(text ?? ""),
      request.ledger,
      Date.now() - startedAt,
      summaryModel,
      usage,
    );
    return result;
  } finally {
    linked.cleanup();
  }
}

export async function summarizeContext(
  request: ContextSummaryRequest,
): Promise<ContextSummaryResult> {
  const provider = await getProviderWithKey(request.providerId);
  cancelContextSummary(request.taskId);
  const controller = new AbortController();
  summaryControllers.set(request.taskId, controller);
  try {
    return await summarizeContextWithProvider(request, provider, {
      signal: controller.signal,
      timeoutMs: 120_000,
    });
  } finally {
    if (summaryControllers.get(request.taskId) === controller)
      summaryControllers.delete(request.taskId);
  }
}

export async function discoverModels(
  providerId: string,
): Promise<ModelConfig[]> {
  return (await probeProvider(providerId)).models;
}

export async function probeProvider(providerId: string) {
  const provider = await getProviderWithKey(providerId);
  const result = await inspectProvider(provider);
  await updateProviderProfile(providerId, result.profile);
  return result;
}

// Third-party relays sometimes hold a stream open but stop sending data (a
// "silent hang"): reader.read() would then block forever and the task appears
// frozen. Guard every read with an idle watchdog; on timeout we cancel the
// reader and throw a message that isRetryableStreamError recognizes, so the
// agent layer can transparently reconnect.
const SSE_IDLE_TIMEOUT_MS = 60_000;
async function* sse(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("服务未返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readWithIdleTimeout = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Cancel the underlying stream so the socket is released, then surface
        // a retryable error. A late read() settle after this is a harmless
        // no-op because the promise is already rejected.
        reader.cancel().catch(() => {});
        reject(new Error("上游长时间没有新数据（连接疑似中断）"));
      }, SSE_IDLE_TIMEOUT_MS);
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            yield { type: "__sse_done" };
            continue;
          }
          if (data) yield JSON.parse(data);
        }
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function* streamChat(
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelEvent> {
  const provider = await getProviderWithKey(request.providerId);
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  if (
    Buffer.byteLength(JSON.stringify(request.messages), "utf8") >
    3 * 1024 * 1024
  )
    throw new Error("对话与上下文总大小超过 3 MB");
  const base = trim(provider.baseUrl);
  if (provider.protocol === "openai-responses") {
    const supportsReasoning =
      inferReasoningConfig(request.modelId, provider.protocol).reasoningMode ===
      "effort";
    const response = await checkedFetch(apiEndpoint(base, "responses"), {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        input: request.messages,
        stream: true,
        reasoning:
          supportsReasoning && request.reasoningEffort !== "auto"
            ? { effort: request.reasoningEffort }
            : undefined,
      }),
    });
    for await (const raw of sse(response)) {
      const parsed = parseResponsesEvent(raw);
      if (parsed.error) throw new Error(parsed.error);
      for (const event of parsed.events) yield event;
    }
  } else if (provider.protocol === "openai-chat") {
    const supportsReasoning =
      inferReasoningConfig(request.modelId, provider.protocol).reasoningMode ===
      "effort";
    const response = await checkedFetch(apiEndpoint(base, "chat/completions"), {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort:
          supportsReasoning && request.reasoningEffort !== "auto"
            ? request.reasoningEffort
            : undefined,
      }),
    });
    for await (const raw of sse(response)) {
      const parsed = parseChatCompletionsEvent(raw);
      if (parsed.error) throw new Error(parsed.error);
      for (const event of parsed.events) yield event;
    }
  } else if (provider.protocol === "anthropic-messages") {
    const response = await checkedFetch(apiEndpoint(base, "messages"), {
      method: "POST",
      signal,
      headers: {
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        max_tokens: 4096,
        stream: true,
      }),
    });
    for await (const raw of sse(response)) {
      const parsed = parseAnthropicMessagesEvent(raw);
      if (parsed.error) throw new Error(parsed.error);
      for (const event of parsed.events) yield event;
    }
  } else throw new Error("Gemini 文本流由 Agent Runtime 处理");
  yield { type: "done" };
}
