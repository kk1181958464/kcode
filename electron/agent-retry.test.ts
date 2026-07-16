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

test("does not retry non-transient model errors", () => {
  assert.equal(isRetryableStreamError(new Error("模型不属于当前供应商或已被移除")), false);
  assert.equal(isRetryableStreamError(new Error("invalid api key")), false);
  assert.equal(isRetryableStreamError(new Error("对话与上下文总大小超过 3 MB")), false);
});