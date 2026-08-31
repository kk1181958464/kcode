import { randomUUID } from "node:crypto";
import type { AgentToolName, Protocol } from "../src/types";

export type AssembledTurn = {
  text: string;
  reasoningContent: string;
  calls: { id: string; name: AgentToolName; input: Record<string, unknown> }[];
  rawCalls: unknown[];
  usage: { input: number; output: number; cached: number };
  // Normalized upstream stop reason (e.g. "length"/"max_tokens" for truncation,
  // "stop"/"end_turn" for a natural finish). Empty when the protocol omits it.
  finishReason: string;
};
type PendingCall = { id: string; name: string; args: string; raw?: any };
type AgentStreamAssemblerOptions = {
  normalizeCumulativeChatChunks?: boolean;
  chatChunkMode?: "delta" | "cumulative" | "auto";
};

const INLINE_REASONING_OPEN_TAGS = ["<think>", "<thinking>"];
const INLINE_REASONING_CLOSE_TAGS = ["</think>", "</thinking>"];

function firstInlineReasoningTag(value: string, tags: readonly string[]) {
  const lower = value.toLowerCase();
  let match: { index: number; length: number } | undefined;
  for (const tag of tags) {
    const index = lower.indexOf(tag);
    if (index >= 0 && (!match || index < match.index))
      match = { index, length: tag.length };
  }
  return match;
}

function pendingInlineReasoningTagLength(
  value: string,
  tags: readonly string[],
) {
  const lower = value.toLowerCase();
  const limit = Math.min(
    lower.length,
    Math.max(...tags.map((tag) => tag.length - 1)),
  );
  for (let length = limit; length > 0; length -= 1) {
    const suffix = lower.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return length;
  }
  return 0;
}

export class AgentStreamAssembler {
  private text = "";
  private rawText = "";
  private reasoningContent = "";
  private inlineTextBuffer = "";
  private inlineReasoning = false;
  private usage = { input: 0, output: 0, cached: 0 };
  private calls = new Map<number, PendingCall>();
  private responseItems: any[] = [];
  private anthropicBlocks: any[] = [];
  private completed = false;
  private finishReason = "";
  // Only visible answer text and tool-call data count as meaningful progress.
  // Reasoning-only and cumulative duplicate chunks keep the transport alive,
  // but must not keep a model turn alive forever.
  private meaningfulOutputVersion = 0;
  constructor(
    private protocol: Protocol,
    private onText?: (delta: string) => void,
    private onReasoning?: (delta: string) => void,
    private options: AgentStreamAssemblerOptions = {},
  ) {}
  consume(event: any) {
    const meaningfulOutputBefore = this.meaningfulOutputVersion;
    if (
      event.error?.message ||
      event.type === "error" ||
      event.type === "response.failed"
    )
      throw new Error(
        event.error?.message ||
          event.response?.error?.message ||
          event.message ||
          "模型流式请求失败",
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
        const index = part.index ?? 0;
        const existing = this.calls.get(index);
        const current = existing ?? {
          id: part.id || randomUUID(),
          name: "",
          args: "",
        };
        const previousId = current.id;
        const previousName = current.name;
        const previousArgs = current.args;
        if (part.id) current.id = part.id;
        current.name = this.appendToolName(current.name, part.function?.name);
        current.args += this.normalizeChatChunk(
          current.args,
          part.function?.arguments,
        );
        this.calls.set(index, current);
        if (
          !existing ||
          current.id !== previousId ||
          current.name !== previousName ||
          current.args !== previousArgs
        )
          this.markMeaningfulOutput();
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
        this.markMeaningfulOutput();
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
        const delta = event.delta || "";
        const existing = this.calls.get(index);
        current.args += delta;
        this.calls.set(index, current);
        if (!existing || delta) this.markMeaningfulOutput();
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
        if (event.content_block?.type === "tool_use") {
          this.markMeaningfulOutput();
          this.calls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: "",
            raw: event.content_block,
          });
        }
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
        const partialJson = event.delta.partial_json || "";
        if (current && partialJson) {
          current.args += partialJson;
          this.markMeaningfulOutput();
        }
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
        if (part.functionCall) {
          this.markMeaningfulOutput();
          this.calls.set(this.calls.size, {
            id: randomUUID(),
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args ?? {}),
            raw: part,
          });
        }
      }
      if (event.usageMetadata)
        this.usage = {
          input: event.usageMetadata.promptTokenCount ?? this.usage.input,
          output: event.usageMetadata.candidatesTokenCount ?? this.usage.output,
          cached:
            event.usageMetadata.cachedContentTokenCount ?? this.usage.cached,
        };
    }
    return this.meaningfulOutputVersion > meaningfulOutputBefore;
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
    this.flushInlineText();
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
            ...(this.reasoningContent
              ? { reasoning_content: this.reasoningContent }
              : {}),
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
      reasoningContent: this.reasoningContent,
      calls,
      rawCalls,
      usage: this.usage,
      finishReason: this.finishReason,
    };
  }
  private addText(delta?: string) {
    if (!delta) return;
    const normalized = this.normalizeChatChunk(this.rawText, delta);
    if (!normalized) return;
    this.rawText += normalized;
    this.consumeInlineText(normalized);
  }
  // Reasoning is separate from answer text, but OpenAI-compatible thinking
  // models require it to be passed back with the assistant tool-call message.
  private addReasoning(delta?: string) {
    if (!delta) return;
    const normalized = this.normalizeChatChunk(this.reasoningContent, delta);
    if (!normalized) return;
    this.reasoningContent += normalized;
    this.onReasoning?.(normalized);
  }
  private appendVisibleText(value: string) {
    if (!value) return;
    this.text += value;
    if (value.trim()) this.markMeaningfulOutput();
    this.onText?.(value);
  }
  private appendInlineReasoning(value: string) {
    if (!value) return;
    this.reasoningContent += value;
    this.onReasoning?.(value);
  }
  private markMeaningfulOutput() {
    this.meaningfulOutputVersion += 1;
  }
  private consumeInlineText(value: string) {
    this.inlineTextBuffer += value;
    while (this.inlineTextBuffer) {
      const tags = this.inlineReasoning
        ? INLINE_REASONING_CLOSE_TAGS
        : INLINE_REASONING_OPEN_TAGS;
      const match = firstInlineReasoningTag(this.inlineTextBuffer, tags);
      if (match) {
        const content = this.inlineTextBuffer.slice(0, match.index);
        if (this.inlineReasoning) this.appendInlineReasoning(content);
        else this.appendVisibleText(content);
        this.inlineTextBuffer = this.inlineTextBuffer.slice(
          match.index + match.length,
        );
        this.inlineReasoning = !this.inlineReasoning;
        continue;
      }
      const pendingLength = pendingInlineReasoningTagLength(
        this.inlineTextBuffer,
        tags,
      );
      const ready = this.inlineTextBuffer.slice(
        0,
        this.inlineTextBuffer.length - pendingLength,
      );
      if (this.inlineReasoning) this.appendInlineReasoning(ready);
      else this.appendVisibleText(ready);
      this.inlineTextBuffer = this.inlineTextBuffer.slice(
        this.inlineTextBuffer.length - pendingLength,
      );
      break;
    }
  }
  private flushInlineText() {
    if (!this.inlineTextBuffer) return;
    if (this.inlineReasoning) this.appendInlineReasoning(this.inlineTextBuffer);
    else this.appendVisibleText(this.inlineTextBuffer);
    this.inlineTextBuffer = "";
  }
  // Tool names normally arrive whole in the first delta. Some OpenAI-compatible
  // relays repeat the full name on every tool_calls fragment; naive `+=` would
  // yield "read_fileread_file" and break tool resolution. Treat an exact repeat
  // or a growing prefix as cumulative, otherwise append (genuinely fragmented).
  private appendToolName(current: string, chunk?: string) {
    if (!chunk) return current;
    if (!current) return chunk;
    if (chunk === current) return current;
    if (chunk.startsWith(current)) return chunk;
    if (current.startsWith(chunk)) return current;
    return current + chunk;
  }
  private normalizeChatChunk(current: string, chunk?: string) {
    if (!chunk) return "";
    const mode =
      this.options.chatChunkMode ??
      (this.options.normalizeCumulativeChatChunks ? "cumulative" : "delta");
    if (
      this.protocol === "openai-chat" &&
      current &&
      chunk.startsWith(current) &&
      (mode === "cumulative" ||
        (mode === "auto" && (chunk === current || current.length >= 4)))
    )
      return chunk.slice(current.length);
    return chunk;
  }
}
