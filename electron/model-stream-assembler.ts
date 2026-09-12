import { AgentStreamAssembler } from "./agent-stream";
import { watchModelSse } from "./model-stream-watchdog";
import type { ToolCall, Turn } from "./agent-types";

export async function parseAssembledModelStream(args: {
  protocol: string;
  response: Response;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onProgress?: (message: string) => void;
  idleTimeoutMs?: number;
  chatChunkMode: "delta" | "cumulative" | "auto";
  meaningfulIdleTimeoutMs?: number;
  maxDurationMs?: number;
  validateCalls: (calls: ToolCall[]) => ToolCall[];
}): Promise<Turn> {
  const assembler = new AgentStreamAssembler(
    args.protocol as any,
    args.onText,
    args.onReasoning,
    { chatChunkMode: args.chatChunkMode },
  );
  for await (const _event of watchModelSse(
    args.response,
    args.signal,
    args.idleTimeoutMs,
    args.onProgress,
    undefined,
    args.meaningfulIdleTimeoutMs,
    (event) => assembler.consume(event),
    args.maxDurationMs,
  )) {
    // The assembler consumes semantic progress before the watchdog updates.
  }
  assembler.assertStreamComplete();
  const assembled = assembler.finish();
  return { ...assembled, calls: args.validateCalls(assembled.calls) };
}
