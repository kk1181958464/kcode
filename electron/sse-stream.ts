import { readStreamChunk } from "./request-guard";

export class SseStreamTimeoutError extends Error {
  constructor(
    public readonly timeoutKind: "idle" | "meaningful",
    public readonly timeoutMs: number,
  ) {
    super(
      timeoutKind === "meaningful"
        ? `模型响应流持续没有正文或工具调用（${Math.round(timeoutMs / 1_000)} 秒）`
        : `模型响应流长时间没有有效事件（${Math.round(timeoutMs / 1_000)} 秒）`,
    );
    this.name = "SseStreamTimeoutError";
  }
}

type SseOptions = {
  signal: AbortSignal;
  idleTimeoutMs?: number;
  /**
   * Marks an SSE event as useful user-facing progress, such as answer text or
   * a tool call. Reasoning-only events still keep the transport alive but do
   * not reset this separate watchdog.
   */
  meaningfulEvent?: (event: any) => boolean;
  meaningfulIdleTimeoutMs?: number;
  onProgress?: (message: string) => void;
  terminalGraceMs?: number;
};

type TerminalKind = "hard" | "soft" | undefined;
const PROGRESS_INTERVAL_MS = 10_000;
const DEFAULT_TERMINAL_GRACE_MS = 750;
const DEFAULT_SEMANTIC_IDLE_TIMEOUT_MS = 120_000;

function terminalKind(event: any): TerminalKind {
  if (
    event?.type === "__sse_done" ||
    event?.type === "response.completed" ||
    event?.type === "response.incomplete" ||
    event?.type === "response.failed" ||
    event?.type === "message_stop" ||
    event?.type === "error" ||
    Boolean(event?.delta?.stop_reason) ||
    Boolean(
      event?.candidates?.some((candidate: any) => candidate?.finishReason),
    )
  )
    return "hard";
  // OpenAI sends the optional usage chunk after finish_reason and before
  // [DONE]. Keep a short, absolute grace period for that trailing metadata.
  if (event?.choices?.some((choice: any) => choice?.finish_reason))
    return "soft";
  return undefined;
}

function parseBlock(block: string) {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data) return [];
  if (data === "[DONE]") return [{ type: "__sse_done" }];
  try {
    return [JSON.parse(data)];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`模型响应流意外中断（SSE 事件 JSON 不完整：${detail}）`);
  }
}

/** Read an SSE JSON response and stop at the protocol's terminal event. */
export async function* readSseJson(
  response: Response,
  options: SseOptions,
): AsyncGenerator<any> {
  if (!response.body) throw new Error("模型没有返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let lastEventAt = Date.now();
  let lastMeaningfulEventAt = lastEventAt;
  let lastProgressAt = lastEventAt;
  let softTerminalRemainingMs: number | undefined;
  const terminalGraceMs = options.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS;
  const idleTimeoutMs =
    options.idleTimeoutMs ?? DEFAULT_SEMANTIC_IDLE_TIMEOUT_MS;
  const meaningfulIdleTimeoutMs = options.meaningfulEvent
    ? (options.meaningfulIdleTimeoutMs ?? idleTimeoutMs)
    : undefined;
  const semanticTimeoutError = () =>
    new SseStreamTimeoutError("idle", idleTimeoutMs);
  const meaningfulTimeoutError = () =>
    new SseStreamTimeoutError("meaningful", meaningfulIdleTimeoutMs ?? 0);
  try {
    while (!terminal) {
      const now = Date.now();
      if (softTerminalRemainingMs !== undefined && softTerminalRemainingMs <= 0)
        break;
      const semanticRemaining = idleTimeoutMs - (now - lastEventAt);
      if (semanticRemaining <= 0) throw semanticTimeoutError();
      const meaningfulRemaining =
        meaningfulIdleTimeoutMs === undefined
          ? Number.POSITIVE_INFINITY
          : meaningfulIdleTimeoutMs - (now - lastMeaningfulEventAt);
      if (meaningfulRemaining <= 0) throw meaningfulTimeoutError();
      const terminalRemaining = softTerminalRemainingMs;
      const readTimeout = Math.max(
        1,
        Math.min(
          semanticRemaining ?? Number.POSITIVE_INFINITY,
          meaningfulRemaining,
          terminalRemaining ?? Number.POSITIVE_INFINITY,
          idleTimeoutMs,
        ),
      );
      let chunk: ReadableStreamReadResult<Uint8Array>;
      const readStartedAt = Date.now();
      try {
        chunk = await readStreamChunk(
          reader,
          options.signal,
          Number.isFinite(readTimeout) ? readTimeout : undefined,
          options.onProgress,
        );
      } catch (error) {
        if (softTerminalRemainingMs !== undefined) break;
        const failedAt = Date.now();
        if (
          meaningfulIdleTimeoutMs !== undefined &&
          failedAt - lastMeaningfulEventAt >= meaningfulIdleTimeoutMs
        )
          throw meaningfulTimeoutError();
        if (failedAt - lastEventAt >= idleTimeoutMs)
          throw semanticTimeoutError();
        throw error;
      }
      if (softTerminalRemainingMs !== undefined)
        softTerminalRemainingMs -= Math.max(0, Date.now() - readStartedAt);
      const { done, value } = chunk;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const events = parseBlock(block);
        if (events.length) lastEventAt = Date.now();
        for (const event of events) {
          const kind = terminalKind(event);
          if (kind || options.meaningfulEvent?.(event))
            lastMeaningfulEventAt = Date.now();
          yield event;
          if (kind === "hard") {
            terminal = true;
            break;
          }
          if (kind === "soft" && softTerminalRemainingMs === undefined)
            softTerminalRemainingMs = terminalGraceMs;
        }
        if (terminal) break;
      }
      const waitedMs = Date.now() - lastEventAt;
      const meaningfulWaitedMs = Date.now() - lastMeaningfulEventAt;
      if (
        !terminal &&
        meaningfulIdleTimeoutMs !== undefined &&
        meaningfulWaitedMs >= PROGRESS_INTERVAL_MS &&
        Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS
      ) {
        lastProgressAt = Date.now();
        options.onProgress?.(
          `模型正在推理，尚未输出正文或工具调用，已等待 ${Math.round(meaningfulWaitedMs / 1_000)} 秒…`,
        );
      } else if (
        !terminal &&
        waitedMs >= PROGRESS_INTERVAL_MS &&
        Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS
      ) {
        lastProgressAt = Date.now();
        options.onProgress?.(
          `模型响应流仍在等待有效数据，已等待 ${Math.round(waitedMs / 1_000)} 秒…`,
        );
      }
      if (done) {
        if (buffer.trim()) {
          const events = parseBlock(buffer);
          if (events.length) lastEventAt = Date.now();
          for (const event of events) {
            if (terminalKind(event) || options.meaningfulEvent?.(event))
              lastMeaningfulEventAt = Date.now();
            yield event;
            if (terminalKind(event)) {
              terminal = true;
              break;
            }
          }
        }
        break;
      }
    }
  } finally {
    // Some proxy-backed streams never settle their cancellation Promise. The
    // protocol terminal event is sufficient to finish this turn, so release
    // the socket in the background instead of hanging the Agent on cancel().
    void reader.cancel().catch(() => undefined);
  }
}
