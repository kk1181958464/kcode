import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuntimeError } from "../src/runtime-errors";

test("classifies transport and provider errors separately", () => {
  assert.deepEqual(classifyRuntimeError("ERR_INCOMPLETE_CHUNKED_ENCODING"), {
    kind: "transport",
    retryable: true,
    userAction: "retry",
  });
  assert.equal(
    classifyRuntimeError("upstream 503").kind,
    "provider_unavailable",
  );
});

test("treats a Chinese connection drop as retryable transport", () => {
  const result = classifyRuntimeError("上游连接失败");
  assert.equal(result.kind, "transport");
  assert.equal(result.retryable, true);
});

test("treats a missing terminal event as a retryable pause", () => {
  const result = classifyRuntimeError(
    "Agent 运行已意外结束，但没有返回完成或错误状态。任务已安全暂停，请重试。",
  );
  assert.equal(result.kind, "transport");
  assert.equal(result.retryable, true);
});

test("does not recommend retrying invalid credentials", () => {
  const result = classifyRuntimeError("401 invalid api key");
  assert.equal(result.kind, "authentication");
  assert.equal(result.retryable, false);
  assert.equal(result.userAction, "change_provider");
});
