import { randomUUID } from "node:crypto";

export type OpenAiChatCall = {
  id: string;
  name: string;
  args: string;
};

export type StreamUsage = { input: number; output: number; cached: number };

export function applyOpenAiChatDelta(args: {
  event: any;
  calls: Map<number, OpenAiChatCall>;
  text: string;
  usage: StreamUsage;
  onText?: (delta: string) => void;
}) {
  const delta = args.event.choices?.[0]?.delta ?? {};
  let text = args.text;
  if (delta.content) {
    text += delta.content;
    args.onText?.(delta.content);
  }
  for (const part of delta.tool_calls ?? []) {
    const index = part.index ?? 0;
    const current = args.calls.get(index) ?? {
      id: part.id || randomUUID(),
      name: "",
      args: "",
    };
    if (part.id) current.id = part.id;
    current.name += part.function?.name || "";
    current.args += part.function?.arguments || "";
    args.calls.set(index, current);
  }
  const usage = args.event.usage;
  return {
    text,
    usage: usage
      ? {
          input: usage.prompt_tokens ?? args.usage.input,
          output: usage.completion_tokens ?? args.usage.output,
          cached:
            usage.prompt_tokens_details?.cached_tokens ??
            usage.prompt_cache_hit_tokens ??
            args.usage.cached,
        }
      : args.usage,
  };
}
