import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../src/types";
import { RendererEventBatcher } from "./renderer-event-batcher";

test("coalesces adjacent text and reasoning deltas", () => {
  const sent: AgentEvent[] = [];
  const batcher = new RendererEventBatcher((event) => sent.push(event));
  batcher.push({ type: "text", delta: "你" });
  batcher.push({ type: "text", delta: "好" });
  batcher.push({ type: "reasoning", delta: "分" });
  batcher.push({ type: "reasoning", delta: "析" });
  assert.deepEqual(sent, []);
  batcher.flush();
  assert.deepEqual(sent, [
    { type: "text", delta: "你好" },
    { type: "reasoning", delta: "分析" },
  ]);
  batcher.close();
});

test("flushes streamed text before a structural event", () => {
  const sent: AgentEvent[] = [];
  const batcher = new RendererEventBatcher((event) => sent.push(event));
  batcher.push({ type: "text", delta: "完成" });
  batcher.push({ type: "done" });
  assert.deepEqual(sent, [{ type: "text", delta: "完成" }, { type: "done" }]);
  batcher.close();
});

test("keeps the final response boundary ordered before buffered final text", () => {
  const sent: AgentEvent[] = [];
  const batcher = new RendererEventBatcher((event) => sent.push(event));
  batcher.push({
    type: "final_response",
    textOffset: 12,
    startedAt: 2_000,
  });
  batcher.push({ type: "text", delta: "最终结果" });
  batcher.flush();
  assert.deepEqual(sent, [
    { type: "final_response", textOffset: 12, startedAt: 2_000 },
    { type: "text", delta: "最终结果" },
  ]);
  batcher.close();
});

test("coalesces activity output without delaying structural activity events", () => {
  const sent: AgentEvent[] = [];
  const batcher = new RendererEventBatcher((event) => sent.push(event));
  batcher.push({
    type: "activity_output",
    activityId: "activity-1",
    mode: "append",
    value: "hello",
  });
  batcher.push({
    type: "activity_output",
    activityId: "activity-1",
    mode: "append",
    value: " world",
  });
  batcher.push({
    type: "activity_output",
    activityId: "activity-1",
    mode: "replace",
    value: "latest",
  });
  batcher.push({ type: "done" });
  assert.deepEqual(sent, [
    {
      type: "activity_output",
      activityId: "activity-1",
      mode: "replace",
      value: "latest",
    },
    { type: "done" },
  ]);
  batcher.close();
});
