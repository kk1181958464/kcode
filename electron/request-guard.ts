import { networkFetch } from "./network";
import { ModelAttemptBudget } from "./model-attempt-budget";
import {
  isDirectNetworkTransportError,
  networkTransportErrorText,
} from "./model-network-transport";

const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const WAIT_PROGRESS_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

export class FirstByteTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`模型请求等待响应超时（${Math.round(timeoutMs / 1_000)} 秒）`);
    this.name = "FirstByteTimeoutError";
  }
}

/** Keeps response metadata available to the stream reconnection policy. */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`请求失败 (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "UpstreamHttpError";
  }
}

export class StreamReadTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`模型响应流长时间没有新数据（${Math.round(timeoutMs / 1_000)} 秒）`);
    this.name = "StreamReadTimeoutError";
  }
}

type FetchWithRetryOptions = {
  signal: AbortSignal;
  firstByteTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Maximum backoff delay cap in ms. Default: 30000 */
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
  attemptBudget?: ModelAttemptBudget;
};

/**
 * Exponential backoff with full jitter (AWS-style).
 * delay = random(0, min(maxMs, baseMs * 2^attempt))
 *
 * Full jitter spreads retry storms better than equal/decorrelated jitter
 * while keeping the expected delay at half the exponential ceiling.
 */
export function exponentialBackoffWithJitter(
  baseMs: number,
  attempt: number,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  // Full jitter: uniform random in [0, exponential]
  return Math.round(Math.random() * exponential);
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function retryAfterMilliseconds(
  response: Response,
  maxMs = MAX_RETRY_AFTER_MS,
  now = Date.now(),
): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Math.min(maxMs, Math.max(0, seconds * 1_000));
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? Math.min(maxMs, Math.max(0, at - now))
    : undefined;
}

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
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    fetchImpl = networkFetch,
    onProgress,
    attemptBudget,
  } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal.aborted) throw abortReason(signal);
    const requestAttempt = attemptBudget?.acquire() ?? attempt + 1;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, firstByteTimeoutMs);
    const startedAt = Date.now();
    onProgress?.(
      `请求已发送，正在等待上游模型首个响应${requestAttempt > 1 ? `（总第 ${requestAttempt} 次尝试）` : ""}…`,
    );
    const progress = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1_000);
      onProgress?.(
        `上游模型尚未返回首个响应，已等待 ${seconds} 秒${requestAttempt > 1 ? `（总第 ${requestAttempt} 次尝试）` : ""}…`,
      );
    }, WAIT_PROGRESS_INTERVAL_MS);
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      if (
        isRetryableStatus(response.status) &&
        attempt < retries &&
        (!attemptBudget || attemptBudget.canAttempt())
      ) {
        // Use server-provided retry-after if available, otherwise exponential backoff + jitter
        const delay =
          retryAfterMilliseconds(response, maxBackoffMs) ??
          exponentialBackoffWithJitter(retryDelayMs, attempt, maxBackoffMs);
        onProgress?.(
          `上游返回 ${response.status}，将在 ${Math.max(1, Math.ceil(delay / 1_000))} 秒后重试…`,
        );
        // A few proxy-backed Electron streams never settle cancel(). Retrying
        // must not depend on that transport cleanup Promise resolving.
        void response.body?.cancel().catch(() => undefined);
        await wait(delay, signal);
        continue;
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (timedOut) {
        lastError = new FirstByteTimeoutError(firstByteTimeoutMs);
        if (
          attempt >= retries ||
          (attemptBudget && !attemptBudget.canAttempt())
        )
          throw lastError;
        const delay = exponentialBackoffWithJitter(
          retryDelayMs,
          attempt,
          maxBackoffMs,
        );
        onProgress?.(
          `上游长时间无响应，将在 ${Math.max(1, Math.ceil(delay / 1_000))} 秒后重试…`,
        );
        await wait(delay, signal);
        continue;
      }
      lastError = error;
      if (attempt >= retries || (attemptBudget && !attemptBudget.canAttempt()))
        throw error;
      await wait(
        exponentialBackoffWithJitter(retryDelayMs, attempt, maxBackoffMs),
        signal,
      );
    } finally {
      clearTimeout(timer);
      clearInterval(progress);
      signal.removeEventListener("abort", abort);
    }
  }
  throw lastError;
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onProgress?: (message: string) => void,
) {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<ReadableStreamReadResult<Uint8Array>>(
    (resolve, reject) => {
      let settled = false;
      const startedAt = Date.now();
      const finish = (
        callback: typeof resolve | typeof reject,
        value: ReadableStreamReadResult<Uint8Array> | unknown,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(progress);
        signal.removeEventListener("abort", abort);
        callback(value as never);
      };
      const abort = () => {
        void reader.cancel().catch(() => undefined);
        finish(reject, abortReason(signal));
      };
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        finish(reject, new StreamReadTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
      const progress = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1_000);
        onProgress?.(`模型响应流仍在等待新数据，已等待 ${seconds} 秒…`);
      }, WAIT_PROGRESS_INTERVAL_MS);
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
// limiting, 5xx, stream idle timeouts, generic proxy phrasing such as
// "Upstream request failed" (often emitted on 200 SSE error events), and the
// Chromium net:: errors that surface when a relay drops a chunked SSE stream
// before its terminating chunk (ERR_INCOMPLETE_CHUNKED_ENCODING and friends).
export function isRetryableStreamError(error: unknown) {
  if (error instanceof UpstreamHttpError)
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  if (error instanceof FirstByteTimeoutError) return true;
  if (
    error instanceof Error &&
    error.name === "SseStreamTimeoutError" &&
    !["meaningful", "absolute"].includes(
      (error as Error & { timeoutKind?: string }).timeoutKind ?? "",
    )
  )
    return true;
  if (
    error instanceof Error &&
    error.name === "ModelAttemptBudgetExhaustedError"
  )
    return true;
  const message = networkTransportErrorText(error);
  return (
    isDirectNetworkTransportError(error) ||
    /overload|rate.?limit|too many requests|429|50[0-9]|bad gateway|service unavailable|gateway time|upstream( request)? (failed|error)|upstream failed|proxy error|temporarily|stream[_ ]?read[_ ]?error|stream error|connection (reset|closed|error)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|fetch failed|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONTENT_LENGTH_MISMATCH|ERR_CONNECTION_(CLOSED|RESET|ABORTED|FAILED)|ERR_NETWORK_CHANGED|ERR_HTTP2_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE|ERR_RESPONSE_HEADERS_TRUNCATED|长时间没有新数据|超时|连接|意外中断|未收到完整响应|工具调用参数不完整|上游网关|网关错误|服务暂时不可用|模型服务暂时不可用|上游服务不可用|上游错误/i.test(
      message,
    )
  );
}
