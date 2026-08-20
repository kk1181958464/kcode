import assert from "node:assert/strict";
import test from "node:test";
import { FirstByteTimeoutError, UpstreamHttpError } from "./request-guard";
import { SseStreamTimeoutError } from "./sse-stream";
import {
  MODEL_STREAM_MAX_ATTEMPTS,
  modelStreamMaxAttempts,
  modelStreamRetryDelayMs,
} from "./model-stream-retry";

test("uses Codex-style bounded exponential stream reconnect delays", () => {
  assert.equal(
    modelStreamRetryDelayMs(new Error("network"), 1, () => 0.5),
    5_000,
  );
  assert.equal(
    modelStreamRetryDelayMs(new Error("network"), 2, () => 0.5),
    10_000,
  );
  assert.equal(
    modelStreamRetryDelayMs(new Error("network"), 5, () => 0.5),
    60_000,
  );
  assert.equal(
    modelStreamRetryDelayMs(new Error("network"), 1, () => 0),
    4_500,
  );
});

test("honors a provider Retry-After value without exceeding the delay cap", () => {
  assert.equal(
    modelStreamRetryDelayMs(new UpstreamHttpError(503, "busy", 42_000), 1),
    42_000,
  );
  assert.equal(
    modelStreamRetryDelayMs(new UpstreamHttpError(503, "busy", 120_000), 1),
    60_000,
  );
});

test("limits expensive timeout retries separately from immediate failures", () => {
  assert.equal(
    modelStreamMaxAttempts(new Error("gateway")),
    MODEL_STREAM_MAX_ATTEMPTS,
  );
  assert.equal(modelStreamMaxAttempts(new FirstByteTimeoutError(300_000)), 2);
  assert.equal(
    modelStreamMaxAttempts(new SseStreamTimeoutError("idle", 120_000)),
    3,
  );
});
