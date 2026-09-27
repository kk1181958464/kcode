import assert from "node:assert/strict";
import test from "node:test";
import {
  UpstreamStreamError,
  upstreamStreamError,
} from "../src/upstream-stream-error";
import { classifyRuntimeError } from "../src/runtime-errors";
import { AgentStreamAssembler } from "./agent-stream";
import { parseAssembledModelStream } from "./model-stream-assembler";
import { isRetryableStreamError } from "./request-guard";
import type { Protocol } from "../src/types";

for (const protocol of [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
] satisfies Protocol[]) {
  test(`${protocol} preserves structured errors through the SSE watchdog and parser`, async () => {
    const detail = {
      code: "server_error",
      type: "api_error",
      message: "opaque failure",
      param: "model",
    };
    const event =
      protocol === "openai-responses"
        ? {
            type: "response.failed",
            response: { error: detail },
            request_id: "req-fixture",
          }
        : { type: "error", error: detail, request_id: "req-fixture" };
    await assert.rejects(
      parseAssembledModelStream({
        protocol,
        response: new Response(`data: ${JSON.stringify(event)}\n\n`),
        signal: new AbortController().signal,
        chatChunkMode: "delta",
        validateCalls: (calls) => calls,
      }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamStreamError);
        assert.equal(error.message, "opaque failure");
        assert.equal(error.code, "server_error");
        assert.equal(error.type, "api_error");
        assert.equal(error.param, "model");
        assert.equal(error.requestId, "req-fixture");
        assert.equal(isRetryableStreamError(error), true);
        assert.equal(classifyRuntimeError(error).kind, "provider_unavailable");
        return true;
      },
    );
  });
}

for (const [code, type, kind, retryable] of [
  ["invalid_api_key", "authentication_error", "authentication", false],
  ["insufficient_quota", "rate_limit_error", "provider_unavailable", false],
  [
    "context_length_exceeded",
    "invalid_request_error",
    "invalid_request",
    false,
  ],
  ["rate_limit_exceeded", "rate_limit_error", "rate_limit", true],
  ["server_error", "api_error", "provider_unavailable", true],
  ["unknown", "overloaded_error", "provider_unavailable", true],
] as const) {
  test(`structured ${code}/${type} takes precedence over message wording`, () => {
    const error = new UpstreamStreamError({
      error: {
        code,
        type,
        message: retryable
          ? "opaque failure"
          : "upstream temporarily unavailable 503",
      },
    });
    assert.equal(classifyRuntimeError(error).kind, kind);
    assert.equal(classifyRuntimeError(error).retryable, retryable);
    assert.equal(isRetryableStreamError(error), retryable);
  });
}

test("recognizes errors without a message, nested Responses errors and numeric statuses", () => {
  assert.throws(
    () =>
      new AgentStreamAssembler("openai-chat").consume({
        error: { code: "invalid_api_key" },
      }),
    UpstreamStreamError,
  );
  const nested = upstreamStreamError({
    type: "response.failed",
    response: { error: { code: "server_error" } },
  });
  assert.equal(nested?.code, "server_error");
  assert.equal(isRetryableStreamError(nested), true);
  const numeric = upstreamStreamError({
    error: { code: 503, status: "UNAVAILABLE" },
  });
  assert.equal(numeric?.code, 503);
  assert.equal(classifyRuntimeError(numeric).retryable, true);
});

for (const message of [
  "Upstream stream ended before completion",
  "Response stream closed before completion",
  "Stream disconnected before completion",
  "Upstream stream terminated prematurely",
]) {
  test("retries premature stream termination: " + message, () => {
    for (const error of [
      new Error(message),
      new UpstreamStreamError({ error: { code: "relay_error", message } }),
    ]) {
      assert.equal(isRetryableStreamError(error), true);
      assert.equal(classifyRuntimeError(error).retryable, true);
    }
  });
}

for (const code of ["stream_incomplete", "incomplete_stream"]) {
  test("retries structured " + code + " even with an opaque message", () => {
    const error = new UpstreamStreamError({
      error: { code, message: "opaque failure" },
    });
    assert.equal(isRetryableStreamError(error), true);
    assert.equal(classifyRuntimeError(error).kind, "transport");
  });
}

test("premature stream wording never overrides permanent provider errors", () => {
  for (const detail of [
    { code: "invalid_api_key" },
    { code: "insufficient_quota" },
    { code: "context_length_exceeded" },
    { code: "stream_incomplete", status: 400 },
    { code: "stream_incomplete", status: 401 },
  ]) {
    const error = new UpstreamStreamError({
      error: { ...detail, message: "Upstream stream ended before completion" },
    });
    assert.equal(isRetryableStreamError(error), false);
    assert.equal(classifyRuntimeError(error).retryable, false);
  }
  assert.equal(isRetryableStreamError(new Error("stream schema invalid")), false);
});

test("keeps message fallback for unknown codes and ignores ordinary stream data", () => {
  const error = new UpstreamStreamError({
    error: {
      code: "custom",
      message: "Internal error during token generation",
    },
  });
  assert.equal(isRetryableStreamError(error), true);
  assert.equal(
    upstreamStreamError({ type: "response.output_text.delta", delta: "hello" }),
    undefined,
  );
  assert.equal(upstreamStreamError({ error: null }), undefined);
  assert.equal(
    classifyRuntimeError(
      new UpstreamStreamError({ error: { code: "unrecognized" } }),
    ).retryable,
    false,
  );
});
