import { readSseJson } from "./sse-stream";

export async function* watchModelSse(
  response: Response,
  signal: AbortSignal,
  idleTimeoutMs?: number,
  onProgress?: (message: string) => void,
  meaningfulEvent?: (event: any) => boolean,
  meaningfulIdleTimeoutMs?: number,
  processEvent?: (event: any) => boolean,
  maxDurationMs?: number,
): AsyncGenerator<any> {
  const meaningfulProgressEvent = meaningfulEvent ?? processEvent;
  yield* readSseJson(response, {
    signal,
    idleTimeoutMs,
    meaningfulEvent,
    meaningfulIdleTimeoutMs: meaningfulProgressEvent
      ? (meaningfulIdleTimeoutMs ?? Math.min(idleTimeoutMs ?? 120_000, 120_000))
      : undefined,
    processEvent,
    maxDurationMs,
    onProgress,
  });
}
