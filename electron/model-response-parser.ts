import { randomUUID } from "node:crypto";
import { type AgentToolName } from "../src/types";
import { watchModelSse } from "./model-stream-watchdog";
import { parseAssembledModelStream } from "./model-stream-assembler";
import {
  applyOpenAiChatDelta,
  type OpenAiChatCall,
} from "./openai-chat-stream";
import type { Turn } from "./agent-types";
import { validCalls } from "./agent-tool-schema";

export async function parseStreamedTurn(
  protocol: string,
  response: Response,
  signal: AbortSignal,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  onProgress?: (message: string) => void,
  idleTimeoutMs?: number,
  chatChunkMode: "delta" | "cumulative" | "auto" = "delta",
  meaningfulIdleTimeoutMs?: number,
  maxDurationMs?: number,
): Promise<Turn> {
  if (response.body) {
    return parseAssembledModelStream({
      protocol,
      response,
      signal,
      onText,
      onReasoning,
      onProgress,
      idleTimeoutMs,
      chatChunkMode,
      meaningfulIdleTimeoutMs,
      maxDurationMs,
      validateCalls: validCalls,
    });
  }
  /* Legacy inline parser retained temporarily as a compatibility reference. */
  let text = "",
    usage = { input: 0, output: 0, cached: 0 };
  const calls = new Map<number, OpenAiChatCall & { raw?: any }>();
  const responseItems: any[] = [],
    anthropicBlocks: any[] = [];
  for await (const event of watchModelSse(response, signal)) {
    if (event.error?.message || event.type === "error")
      throw new Error(
        event.error?.message || event.message || "模型流式请求失败",
      );
    if (protocol === "openai-chat") {
      const next = applyOpenAiChatDelta({
        event,
        calls,
        text,
        usage,
        onText,
      });
      text = next.text;
      usage = next.usage;
    } else if (protocol === "openai-responses") {
      if (event.type === "response.output_text.delta" && event.delta) {
        text += event.delta;
        onText?.(event.delta);
      }
      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const index = event.output_index ?? calls.size;
        calls.set(index, {
          id: event.item.call_id || event.item.id || randomUUID(),
          name: event.item.name || "",
          args: event.item.arguments || "",
          raw: event.item,
        });
      }
      if (event.type === "response.function_call_arguments.delta") {
        const index = event.output_index ?? 0,
          current = calls.get(index) ?? {
            id: event.call_id || event.item_id || randomUUID(),
            name: event.name || "",
            args: "",
          };
        current.args += event.delta || "";
        calls.set(index, current);
      }
      if (event.type === "response.output_item.done" && event.item)
        responseItems.push(event.item);
      if (event.response?.usage)
        usage = {
          input: event.response.usage.input_tokens ?? usage.input,
          output: event.response.usage.output_tokens ?? usage.output,
          cached:
            event.response.usage.input_tokens_details?.cached_tokens ??
            usage.cached,
        };
    } else if (protocol === "anthropic-messages") {
      if (event.type === "message_start")
        usage.input = event.message?.usage?.input_tokens ?? usage.input;
      if (event.type === "content_block_start") {
        anthropicBlocks[event.index] = event.content_block;
        if (event.content_block?.type === "tool_use")
          calls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: "",
            raw: event.content_block,
          });
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        text += event.delta.text || "";
        onText?.(event.delta.text || "");
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const current = calls.get(event.index);
        if (current)
          current.args = current.args + (event.delta.partial_json || "");
      }
      if (event.type === "message_delta")
        usage.output = event.usage?.output_tokens ?? usage.output;
    } else {
      const parts = event.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string") {
          text += part.text;
          onText?.(part.text);
        }
        if (part.functionCall)
          calls.set(calls.size, {
            id: randomUUID(),
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args ?? {}),
            raw: part,
          });
      }
      if (event.usageMetadata)
        usage = {
          input: event.usageMetadata.promptTokenCount ?? usage.input,
          output: event.usageMetadata.candidatesTokenCount ?? usage.output,
          cached: event.usageMetadata.cachedContentTokenCount ?? usage.cached,
        };
    }
  }
  const parsedCalls = [...calls.values()].map((call) => ({
    id: call.id,
    name: call.name as AgentToolName,
    input: JSON.parse(call.args || "{}"),
  }));
  let rawCalls: unknown[] = [];
  if (protocol === "openai-chat")
    rawCalls = [
      {
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: [...calls.values()].map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args || "{}" },
          })),
        },
      },
    ];
  else if (protocol === "openai-responses")
    rawCalls = responseItems.filter((item) => item.type === "function_call");
  else if (protocol === "anthropic-messages")
    rawCalls = anthropicBlocks
      .filter((block) => block?.type === "tool_use")
      .map((block, index) => ({
        ...block,
        input: parsedCalls[index]?.input ?? {},
      }));
  else rawCalls = [...calls.values()].map((call) => call.raw).filter(Boolean);
  return { text, calls: validCalls(parsedCalls), rawCalls, usage };
}

export function parseModelResponse(protocol: string, json: any): Turn {
  if (protocol === "openai-chat") {
    const message = json.choices?.[0]?.message ?? {};
    const calls = (message.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      input: JSON.parse(c.function.arguments || "{}"),
    }));
    return {
      text: message.content || "",
      reasoningContent: message.reasoning_content || message.reasoning || "",
      calls: validCalls(calls),
      rawCalls: [
        {
          message,
          content: message.content,
          reasoning_content: message.reasoning_content,
          reasoning_details: message.reasoning_details,
          tool_calls: message.tool_calls ?? [],
        },
      ],
      usage: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
        cached:
          json.usage?.prompt_tokens_details?.cached_tokens ??
          json.usage?.prompt_cache_hit_tokens ??
          0,
      },
    };
  }
  if (protocol === "openai-responses") {
    const output = json.output ?? [];
    const calls = output
      .filter((x: any) => x.type === "function_call")
      .map((c: any) => ({
        id: c.call_id,
        name: c.name,
        input: JSON.parse(c.arguments || "{}"),
      }));
    const text = output
      .flatMap((x: any) => x.content ?? [])
      .filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text)
      .join("");
    return {
      text,
      calls: validCalls(calls),
      rawCalls: output.filter((x: any) => x.type === "function_call"),
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cached: json.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
  if (protocol === "anthropic-messages") {
    const content = json.content ?? [];
    return {
      text: content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join(""),
      calls: validCalls(
        content
          .filter((x: any) => x.type === "tool_use")
          .map((c: any) => ({ id: c.id, name: c.name, input: c.input })),
      ),
      rawCalls: content.filter((x: any) => x.type === "tool_use"),
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cached: json.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const calls = parts
    .filter((part: any) => part.functionCall)
    .map((part: any) => ({
      id: randomUUID(),
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    }));
  return {
    text: parts
      .filter((part: any) => typeof part.text === "string")
      .map((part: any) => part.text)
      .join(""),
    calls: validCalls(calls),
    rawCalls: parts.filter((part: any) => part.functionCall),
    usage: {
      input: json.usageMetadata?.promptTokenCount ?? 0,
      output: json.usageMetadata?.candidatesTokenCount ?? 0,
      cached: json.usageMetadata?.cachedContentTokenCount ?? 0,
    },
  };
}
