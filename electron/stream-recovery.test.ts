import test from "node:test";
import assert from "node:assert/strict";
import { RetryTextReconciler } from "./stream-recovery";

test("suppresses replayed text after a stream reconnect", () => {
  const text = new RetryTextReconciler();
  assert.deepEqual(text.push("已经"), { reset: false, delta: "已经" });
  assert.deepEqual(text.push("完成检查"), {
    reset: false,
    delta: "完成检查",
  });

  text.beginAttempt();
  assert.deepEqual(text.push("已经完成"), { reset: false, delta: "" });
  assert.deepEqual(text.push("检查并修复"), {
    reset: false,
    delta: "并修复",
  });
  assert.deepEqual(text.completeAttempt(), { reset: false, delta: "" });
});

test("keeps a long visible answer while a divergent retry is still shorter", () => {
  const text = new RetryTextReconciler();
  text.push("旧的回答已经正常输出了很长一段内容");
  text.beginAttempt();
  assert.deepEqual(text.push("新的回答"), {
    reset: false,
    delta: "",
  });
  assert.deepEqual(text.completeAttempt(), {
    reset: true,
    delta: "新的回答",
  });
});

test("switches a divergent retry only after the attempt completes", () => {
  const text = new RetryTextReconciler();
  text.push("abcdefgh");
  text.beginAttempt();
  assert.deepEqual(text.push("xy"), { reset: false, delta: "" });
  assert.deepEqual(text.push("z1234567"), {
    reset: false,
    delta: "",
  });
  assert.deepEqual(text.push("89"), { reset: false, delta: "" });
  assert.deepEqual(text.completeAttempt(), {
    reset: true,
    delta: "xyz123456789",
  });
});

test("a failed divergent retry cannot erase text before the next attempt", () => {
  const text = new RetryTextReconciler();
  text.push("already visible");

  text.beginAttempt();
  assert.deepEqual(text.push("different"), { reset: false, delta: "" });

  text.beginAttempt();
  assert.deepEqual(text.push("already visible"), {
    reset: false,
    delta: "",
  });
  assert.deepEqual(text.push(" and complete"), {
    reset: false,
    delta: " and complete",
  });
});
