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
