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
});

test("resets visible text when a retry genuinely diverges", () => {
  const text = new RetryTextReconciler();
  text.push("旧的回答");
  text.beginAttempt();
  assert.deepEqual(text.push("新的回答"), {
    reset: true,
    delta: "新的回答",
  });
});
