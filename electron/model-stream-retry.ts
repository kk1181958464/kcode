import { FirstByteTimeoutError, UpstreamHttpError } from "./request-guard";
import { SseStreamTimeoutError } from "./sse-stream";

export const MODEL_STREAM_MAX_ATTEMPTS = 6;
export const MODEL_TURN_HTTP_ATTEMPTS = 10;
const INITIAL_STREAM_RETRY_DELAY_MS = 5_000;
const MAX_STREAM_RETRY_DELAY_MS = 60_000;

/**
 * A first-byte timeout has already consumed up to five minutes. Mid-stream
 * idle timeouts are also expensive, so they use smaller retry ceilings than
 * immediate transport and HTTP failures.
 */
export function modelStreamMaxAttempts(error: unknown) {
  if (error instanceof FirstByteTimeoutError) return 2;
  if (error instanceof SseStreamTimeoutError && error.timeoutKind === "idle")
    return 3;
  return MODEL_STREAM_MAX_ATTEMPTS;
}

/** Codex-style exponential backoff with narrow jitter and Retry-After support. */
export function modelStreamRetryDelayMs(
  error: unknown,
  retryNumber: number,
  random = Math.random,
) {
  if (error instanceof UpstreamHttpError && error.retryAfterMs !== undefined)
    return Math.min(MAX_STREAM_RETRY_DELAY_MS, Math.max(0, error.retryAfterMs));
  const exponent = Math.max(0, Math.floor(retryNumber) - 1);
  const base = Math.min(
    MAX_STREAM_RETRY_DELAY_MS,
    INITIAL_STREAM_RETRY_DELAY_MS * 2 ** exponent,
  );
  const unit = Math.min(1, Math.max(0, random()));
  const jitter = 0.9 + unit * 0.2;
  return Math.min(MAX_STREAM_RETRY_DELAY_MS, Math.round(base * jitter));
}
