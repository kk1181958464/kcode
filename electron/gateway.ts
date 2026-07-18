import { inferContextWindow, inferReasoningConfig, type ContextLedger, type ContextSummaryRequest, type ContextSummaryResult, type ModelConfig, type ModelEvent, type ModelRequest } from "../src/types";
import {
  parseAnthropicMessagesEvent,
  parseChatCompletionsEvent,
  parseResponsesEvent,
} from "./protocols";
import { getProviderWithKey } from "./store";
import { networkFetch } from "./network";

const trim = (url: string) => url.replace(/\/+$/, "");
const apiEndpoint = (baseUrl: string, resource: string) => {
  const base = trim(baseUrl);
  return `${base}${/\/v1$/i.test(base) ? "" : "/v1"}/${resource}`;
};

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
export function cancelContextSummary(taskId: string) { summaryControllers.get(taskId)?.abort(); summaryControllers.delete(taskId); }
const parseSummary = (text: string, fallback: ContextLedger, durationMs: number, usage?: { input: number; output: number }): ContextSummaryResult => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("模型未返回 JSON 摘要");
  const value = JSON.parse(match[0]) as { summary?: unknown; ledger?: Partial<Record<keyof ContextLedger, unknown>> };
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("模型摘要为空");
  const list = (key: keyof ContextLedger) => Array.isArray(value.ledger?.[key]) ? (value.ledger![key] as unknown[]).filter((item): item is string => typeof item === "string").slice(-64) : fallback[key];
  // connections are exact local facts, not something the model should rewrite:
  // always carry the fallback (locally derived) list through verbatim.
  return { summary: value.summary.slice(0, 40_000), ledger: { goals: list("goals"), decisions: list("decisions"), changedFiles: list("changedFiles"), validations: list("validations"), failures: list("failures"), pending: list("pending"), connections: fallback.connections ?? [] }, modelGenerated: true, durationMs, usage };
};

export async function summarizeContext(request: ContextSummaryRequest): Promise<ContextSummaryResult> {
  const provider = await getProviderWithKey(request.providerId);
  cancelContextSummary(request.taskId);
  const controller = new AbortController();
  summaryControllers.set(request.taskId, controller);
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const prompt = `Compress this coding-agent history. Return JSON only with shape {"summary":"markdown","ledger":{"goals":[],"decisions":[],"changedFiles":[],"validations":[],"failures":[],"pending":[],"connections":[]}}. Preserve explicit constraints, current goal, file paths, commands that matter, validation results, failures, and unfinished work. Always keep every established connection (SSH/MySQL host, port, user) verbatim in both the summary text and ledger.connections so the session can be reused without re-asking the user. Remove repetition.\n\nExisting ledger:\n${JSON.stringify(request.ledger)}\n\nHistory:\n${request.source.slice(-120_000)}`;
  try {
    let url = "", headers: Record<string, string> = { "Content-Type": "application/json" }, body: Record<string, unknown>;
    if (provider.protocol === "openai-chat") {
      url = apiEndpoint(provider.baseUrl, "chat/completions"); headers.Authorization = `Bearer ${provider.apiKey}`;
      body = { model: request.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 4000, stream: false };
    } else if (provider.protocol === "openai-responses") {
      url = apiEndpoint(provider.baseUrl, "responses"); headers.Authorization = `Bearer ${provider.apiKey}`;
      body = { model: request.modelId, input: prompt, max_output_tokens: 4000 };
    } else if (provider.protocol === "anthropic-messages") {
      url = apiEndpoint(provider.baseUrl, "messages"); headers["x-api-key"] = provider.apiKey; headers["anthropic-version"] = "2023-06-01";
      body = { model: request.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 4000 };
    } else {
      url = `${trim(provider.baseUrl)}/v1beta/models/${encodeURIComponent(request.modelId)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
      body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4000, responseMimeType: "application/json" } };
    }
    const response = await checkedFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const json = await response.json() as any;
    const text = provider.protocol === "openai-chat" ? json.choices?.[0]?.message?.content : provider.protocol === "openai-responses" ? (json.output_text ?? json.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("")) : provider.protocol === "anthropic-messages" ? json.content?.map((item: any) => item.text ?? "").join("") : json.candidates?.[0]?.content?.parts?.map((item: any) => item.text ?? "").join("");
    const usage = provider.protocol === "openai-chat" ? { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 } : provider.protocol === "openai-responses" ? { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 } : provider.protocol === "anthropic-messages" ? { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 } : { input: json.usageMetadata?.promptTokenCount ?? 0, output: json.usageMetadata?.candidatesTokenCount ?? 0 };
    return parseSummary(String(text ?? ""), request.ledger, Date.now() - startedAt, usage);
  } finally { clearTimeout(timer); if (summaryControllers.get(request.taskId) === controller) summaryControllers.delete(request.taskId); }
}

export async function discoverModels(
  providerId: string,
): Promise<ModelConfig[]> {
  const provider = await getProviderWithKey(providerId);
  if (provider.protocol === "gemini-generate-content") {
    const response = await checkedFetch(`${trim(provider.baseUrl)}/v1beta/models?key=${encodeURIComponent(provider.apiKey)}`, {});
    const json = await response.json() as { models?: { name: string; displayName?: string; inputTokenLimit?: number }[] };
    return (json.models ?? []).filter(model => model.name.startsWith("models/")).map(model => ({ id: `${provider.id}:${model.name.slice(7)}`, modelId: model.name.slice(7), displayName: model.displayName || model.name.slice(7), protocol: provider.protocol, contextWindow: model.inputTokenLimit ?? inferContextWindow(model.name.slice(7)), ...inferReasoningConfig(model.name.slice(7), provider.protocol) }));
  }
  const headers: Record<string, string> =
    provider.protocol === "anthropic-messages"
      ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${provider.apiKey}` };
  const response = await checkedFetch(apiEndpoint(provider.baseUrl, "models"), {
    headers,
  });
  const json = (await response.json()) as {
    data?: { id: string; display_name?: string }[];
  };
  return (json.data ?? []).map((model) => ({
    id: `${provider.id}:${model.id}`,
    modelId: model.id,
    displayName: model.display_name || model.id,
    protocol: provider.protocol,
    contextWindow: inferContextWindow(model.id),
    ...inferReasoningConfig(model.id, provider.protocol),
  }));
}

async function* sse(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error("服务未返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
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
