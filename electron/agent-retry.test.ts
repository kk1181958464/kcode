import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableStreamError } from "./request-guard";

test("treats generic upstream proxy failures as retryable", () => {
  assert.equal(isRetryableStreamError(new Error("Upstream request failed")), true);
  assert.equal(isRetryableStreamError(new Error("upstream error from gateway")), true);
  assert.equal(isRetryableStreamError(new Error("proxy error")), true);
  assert.equal(isRetryableStreamError(new Error("请求失败 (502): bad gateway")), true);
  assert.equal(isRetryableStreamError(new Error("模型响应流意外中断（上游连接在完成前断开）")), true);
  assert.equal(isRetryableStreamError(new Error("模型响应流意外中断（工具调用参数不完整）")), true);
});

test("treats Chromium net:: mid-stream drops as retryable", () => {
  // A relay that closes a chunked SSE stream before its terminating chunk
  // surfaces as these net:: errors; they must reconnect, not fail the task.
  assert.equal(
    isRetryableStreamError(new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING")),
    true,
  );
  assert.equal(
    isRetryableStreamError(new Error("net::ERR_CONNECTION_CLOSED")),
    true,
  );
  assert.equal(
    isRetryableStreamError(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")),
    true,
  );
  assert.equal(
    isRetryableStreamError(new Error("net::ERR_CONTENT_LENGTH_MISMATCH")),
    true,
  );
  assert.equal(
    isRetryableStreamError(new Error("net::ERR_EMPTY_RESPONSE")),
    true,
  );
});

test("does not retry non-transient model errors", () => {
  assert.equal(isRetryableStreamError(new Error("模型不属于当前供应商或已被移除")), false);
  assert.equal(isRetryableStreamError(new Error("invalid api key")), false);
  assert.equal(isRetryableStreamError(new Error("对话与上下文总大小超过 3 MB")), false);
});