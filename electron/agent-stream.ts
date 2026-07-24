import { randomUUID } from "node:crypto";
import type { AgentToolName, Protocol } from "../src/types";

export type AssembledTurn = {
  text: string;
  calls: { id: string; name: AgentToolName; input: Record<string, unknown> }[];
  rawCalls: unknown[];
  usage: { input: number; output: number; cached: number };
  // Normalized upstream stop reason (e.g. "length"/"max_tokens" for truncation,
  // "stop"/"end_turn" for a natural finish). Empty when the protocol omits it.
  finishReason: string;
};
type PendingCall = { id: string; name: string; args: string; raw?: any };

export class AgentStreamAssembler {
  private text = "";
  private usage = { input: 0, output: 0, cached: 0 };
  private calls = new Map<number, PendingCall>();
  private responseItems: any[] = [];
  private anthropicBlocks: any[] = [];
  private completed = false;
  private finishReason = "";
  constructor(
    private protocol: Protocol,
    private onText?: (delta: string) => void,
    private onReasoning?: (delta: string) => void,
  ) {}
  consume(event: any) {
    if (event.error?.message || event.type === "error")
      throw new Error(
        event.error?.message || event.message || "模型流式请求失败",
      );
    // Protocol-level completion markers. Without these, a quiet upstream
    // disconnect looks identical to a finished answer.
    if (event.type === "__sse_done") this.completed = true;
    if (this.protocol === "openai-chat") {
      if (event.choices?.[0]?.finish_reason) {
        this.completed = true;
        this.finishReason = event.choices[0].finish_reason;
      }
      const delta = event.choices?.[0]?.delta ?? {};
      this.addText(delta.content);
      this.addReasoning(delta.reasoning_content ?? delta.reasoning);
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0,
          current = this.calls.get(index) ?? {
            id: part.id || randomUUID(),
            name: "",
            args: "",
          };
        if (part.id) current.id = part.id;
        current.name += part.function?.name || "";
        current.args += part.function?.arguments || "";
        this.calls.set(index, current);
      }
      if (event.usage)
        this.usage = {
          input: event.usage.prompt_tokens ?? this.usage.input,
          output: event.usage.completion_tokens ?? this.usage.output,
          cached:
            event.usage.prompt_tokens_details?.cached_tokens ??
            event.usage.prompt_cache_hit_tokens ??
            this.usage.cached,
        };
    } else if (this.protocol === "openai-responses") {
      if (
        event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed"
      ) {
        this.completed = true;
        if (event.type === "response.incomplete")
          this.finishReason =
            event.response?.incomplete_details?.reason === "max_output_tokens"
              ? "length"
              : (event.response?.incomplete_details?.reason ?? "incomplete");
      }
      if (event.type === "response.output_text.delta")
        this.addText(event.delta);
      if (
        event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_text.delta"
      )
        this.addReasoning(event.delta);
      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const index = event.output_index ?? this.calls.size;
        this.calls.set(index, {
          id: event.item.call_id || event.item.id || randomUUID(),
          name: event.item.name || "",
          args: event.item.arguments || "",
          raw: event.item,
        });
      }
      if (event.type === "response.function_call_arguments.delta") {
        const index = event.output_index ?? 0,
          current = this.calls.get(index) ?? {
            id: event.call_id || event.item_id || randomUUID(),
            name: event.name || "",
            args: "",
          };
        current.args += event.delta || "";
        this.calls.set(index, current);
      }
      if (event.type === "response.output_item.done" && event.item)
        this.responseItems.push(event.item);
      if (event.response?.usage)
        this.usage = {
          input: event.response.usage.input_tokens ?? this.usage.input,
          output: event.response.usage.output_tokens ?? this.usage.output,
          cached:
            event.response.usage.input_tokens_details?.cached_tokens ??
            this.usage.cached,
        };
    } else if (this.protocol === "anthropic-messages") {
      if (event.type === "message_stop") this.completed = true;
      if (event.type === "message_delta" && event.delta?.stop_reason) {
        this.completed = true;
        this.finishReason = event.delta.stop_reason;
      }
      if (event.type === "message_start")
        this.usage.input =
          event.message?.usage?.input_tokens ?? this.usage.input;
      if (event.type === "content_block_start") {
        this.anthropicBlocks[event.index] = event.content_block;
        if (event.content_block?.type === "tool_use")
          this.calls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: "",
            raw: event.content_block,
          });
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      )
        this.addText(event.delta.text);
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "thinking_delta"
      )
        this.addReasoning(event.delta.thinking);
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const current = this.calls.get(event.index);
        if (current) current.args += event.delta.partial_json || "";
      }
      if (event.type === "message_delta")
        this.usage.output = event.usage?.output_tokens ?? this.usage.output;
    } else {
      if (event.candidates?.[0]?.finishReason) {
        this.completed = true;
        this.finishReason = event.candidates[0].finishReason;
      }
      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === "string") this.addText(part.text);
        if (part.functionCall)
          this.calls.set(this.calls.size, {
            id: randomUUID(),
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args ?? {}),
            raw: part,
          });
      }
      if (event.usageMetadata)
        this.usage = {
          input: event.usageMetadata.promptTokenCount ?? this.usage.input,
          output: event.usageMetadata.candidatesTokenCount ?? this.usage.output,
          cached:
            event.usageMetadata.cachedContentTokenCount ?? this.usage.cached,
        };
    }
  }
  assertStreamComplete() {
    // Empty args are valid for no-arg tools; only broken JSON means the
    // stream was cut mid tool-call.
    const pendingArgs = [...this.calls.values()].some((call) => {
      if (!call.args) return false;
      try {
        JSON.parse(call.args);
        return false;
      } catch {
        return true;
      }
    });
    if (pendingArgs)
      throw new Error("模型响应流意外中断（工具调用参数不完整）");
    if (this.completed) return;
    if (this.text || this.calls.size)
      throw new Error("模型响应流意外中断（上游连接在完成前断开）");
    throw new Error("模型响应流意外中断（未收到完整响应）");
  }
  finish(): AssembledTurn {
    const calls = [...this.calls.values()].map((call) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.args || "{}") as Record<string, unknown>;
      } catch {
        throw new Error("模型响应流意外中断（工具调用参数不完整）");
      }
      return {
        id: call.id,
        name: call.name as AgentToolName,
        input,
      };
    });
    let rawCalls: unknown[] = [];
    if (this.protocol === "openai-chat")
      rawCalls = [
        {
          message: {
            role: "assistant",
            content: this.text || null,
            tool_calls: [...this.calls.values()].map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.args || "{}" },
            })),
          },
        },
      ];
    else if (this.protocol === "openai-responses")
      rawCalls = this.responseItems.filter(
        (item) => item.type === "function_call",
      );
    else if (this.protocol === "anthropic-messages")
      rawCalls = this.anthropicBlocks
        .filter((block) => block?.type === "tool_use")
        .map((block, index) => ({
          ...block,
          input: calls[index]?.input ?? {},
        }));
    else
      rawCalls = [...this.calls.values()]
        .map((call) => call.raw)
        .filter(Boolean);
    return {
      text: this.text,
      calls,
      rawCalls,
      usage: this.usage,
      finishReason: this.finishReason,
    };
  }
  private addText(delta?: string) {
    if (!delta) return;
    this.text += delta;
    this.onText?.(delta);
  }
  // Reasoning/thinking deltas are surfaced live for the working indicator but
  // never accumulated into the turn text — they are not part of the answer.
  private addReasoning(delta?: string) {
    if (!delta) return;
    this.onReasoning?.(delta);
  }
}
