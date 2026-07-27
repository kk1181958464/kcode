import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_PACING_INTERVAL_MS,
  takeStreamPacedSlice,
} from "../src/stream-pacing";

test("stream pacing releases a stable two-character slice normally", () => {
  assert.deepEqual(takeStreamPacedSlice("模型正在输出"), {
    slice: "模型",
    remaining: "正在输出",
  });
  assert.equal(STREAM_PACING_INTERVAL_MS, 50);
});

test("stream pacing holds a singleton until the next character arrives", () => {
  assert.deepEqual(takeStreamPacedSlice("模"), {
    slice: "",
    remaining: "模",
  });
  assert.deepEqual(takeStreamPacedSlice("模", false, true), {
    slice: "模",
    remaining: "",
  });
});

test("stream pacing accelerates gradually when the backlog grows", () => {
  assert.equal(takeStreamPacedSlice("字".repeat(65)).slice.length, 4);
  assert.equal(takeStreamPacedSlice("字".repeat(161)).slice.length, 8);
});

test("stream pacing drains all text on completion", () => {
  assert.deepEqual(takeStreamPacedSlice("最后一段", true), {
    slice: "最后一段",
    remaining: "",
  });
});

test("stream pacing does not split surrogate pairs", () => {
  assert.deepEqual(takeStreamPacedSlice("你好😀世界"), {
    slice: "你好",
    remaining: "😀世界",
  });
  assert.deepEqual(takeStreamPacedSlice("😀世界"), {
    slice: "😀世",
    remaining: "界",
  });
});