const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

type FetchWithRetryOptions = {
  signal: AbortSignal;
  firstByteTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
};

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("任务已取消", "AbortError");
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
) {
  const {
    signal,
    firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    retries = 1,
    retryDelayMs = 500,
    fetchImpl = fetch,
  } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal.aborted) throw abortReason(signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, firstByteTimeoutMs);
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
        await response.body?.cancel().catch(() => undefined);
        await wait(retryDelayMs * (attempt + 1), signal);
        continue;
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (timedOut)
        throw new Error(
          `模型请求等待响应超时（${Math.round(firstByteTimeoutMs / 1_000)} 秒）`,
        );
      lastError = error;
      if (attempt >= retries) throw error;
      await wait(retryDelayMs * (attempt + 1), signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  throw lastError;
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
) {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<ReadableStreamReadResult<Uint8Array>>(
    (resolve, reject) => {
      let settled = false;
      const finish = (
        callback: typeof resolve | typeof reject,
        value: ReadableStreamReadResult<Uint8Array> | unknown,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        callback(value as never);
      };
      const abort = () => {
        void reader.cancel().catch(() => undefined);
        finish(reject, abortReason(signal));
      };
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        finish(
          reject,
          new Error(
            `模型响应流长时间没有新数据（${Math.round(idleTimeoutMs / 1_000)} 秒）`,
          ),
        );
      }, idleTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      reader.read().then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error),
      );
    },
  );
}

export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await readStreamChunk(
      reader,
      signal,
      idleTimeoutMs,
    );
    text += decoder.decode(value, { stream: !done });
    if (done) return text;
  }
}
// Mid-stream / proxy failures that are worth retrying: upstream overload, rate
// limiting, 5xx, stream idle timeouts, and generic proxy phrasing such as
// "Upstream request failed" (often emitted on 200 SSE error events).
export function isRetryableStreamError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /overload|rate.?limit|too many requests|429|50[0-9]|bad gateway|service unavailable|gateway time|upstream( request)? (failed|error)|upstream failed|proxy error|temporarily|stream[_ ]?read[_ ]?error|stream error|connection (reset|closed|error)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|fetch failed|长时间没有新数据|超时|连接|意外中断|未收到完整响应|工具调用参数不完整/i.test(
    message,
  );
}
