import type { ModelEvent } from "../src/types";

export type ParsedProtocolEvent = {
  events: ModelEvent[];
  error?: string;
};

export function parseResponsesEvent(raw: unknown): ParsedProtocolEvent {
  const event = raw as {
    type?: string;
    delta?: string;
    message?: string;
    response?: {
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
      incomplete_details?: { reason?: string };
    };
  };
  if (event.type === "response.output_text.delta" && event.delta)
    return { events: [{ type: "text", delta: event.delta }] };
  if (event.type === "response.completed" && event.response?.usage)
    return {
      events: [
        {
          type: "usage",
          input: event.response.usage.input_tokens ?? 0,
          output: event.response.usage.output_tokens ?? 0,
        },
      ],
    };
  if (event.type === "response.failed" || event.type === "error")
    return {
      events: [],
      error:
        event.response?.error?.message ||
        event.message ||
        "Responses API 请求失败",
    };
  if (event.type === "response.incomplete")
    return {
      events: [],
      error:
        event.response?.incomplete_details?.reason ||
        "Responses API 响应不完整",
    };
  return { events: [] };
}

export function parseChatCompletionsEvent(raw: unknown): ParsedProtocolEvent {
  const event = raw as {
    choices?: {
      delta?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
      };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (event.error?.message) return { events: [], error: event.error.message };
  const events: ModelEvent[] = [];
  const delta = event.choices?.[0]?.delta?.content;
  if (delta) events.push({ type: "text", delta });
  const reasoning =
    event.choices?.[0]?.delta?.reasoning_content ??
    event.choices?.[0]?.delta?.reasoning;
  if (reasoning) events.push({ type: "reasoning", delta: reasoning });
  if (event.usage)
    events.push({
      type: "usage",
      input: event.usage.prompt_tokens ?? 0,
      output: event.usage.completion_tokens ?? 0,
    });
  return { events };
}

export function parseAnthropicMessagesEvent(raw: unknown): ParsedProtocolEvent {
  const event = raw as {
    type?: string;
    delta?: { text?: string };
    message?: { usage?: { input_tokens?: number } };
    usage?: { output_tokens?: number };
    error?: { message?: string };
  };
  if (event.type === "error")
    return {
      events: [],
      error: event.error?.message || "Anthropic Messages 请求失败",
    };
  if (event.type === "content_block_delta" && event.delta?.text)
    return { events: [{ type: "text", delta: event.delta.text }] };
  if (event.type === "message_start")
    return {
      events: [
        {
          type: "usage",
          input: event.message?.usage?.input_tokens ?? 0,
          output: 0,
        },
      ],
    };
  if (event.type === "message_delta" && event.usage)
    return {
      events: [
        {
          type: "usage",
          input: 0,
          output: event.usage.output_tokens ?? 0,
        },
      ],
    };
  return { events: [] };
}
