import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_STREAM_PAUSE_MS,
  STREAM_PACING_INTERVAL_MS,
  StreamPacingBuffer,
  takeStreamPacedSlice,
} from "../src/stream-pacing";

test("stream pacing releases a stable two-character slice normally", () => {
  assert.deepEqual(takeStreamPacedSlice("模型正在输出"), {
    slice: "模型",
    remaining: "正在输出",
  });
  assert.equal(STREAM_PACING_INTERVAL_MS, 50);
  assert.equal(COMPOSER_STREAM_PAUSE_MS, 120);
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
  assert.equal(takeStreamPacedSlice("字".repeat(513)).slice.length, 24);
  assert.equal(takeStreamPacedSlice("字".repeat(2_049)).slice.length, 129);
  assert.equal(takeStreamPacedSlice("字".repeat(100_000)).slice.length, 8_192);
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

test("incremental pacing buffer consumes only new Unicode deltas", () => {
  const buffer = new StreamPacingBuffer();
  buffer.append("你好");
  buffer.append("😀世界");
  assert.equal(buffer.length, 5);
  assert.equal(buffer.take(), "你好");
  assert.equal(buffer.take(), "😀世");
  assert.equal(buffer.take(false, true), "界");
  assert.equal(buffer.length, 0);
});

test("incremental pacing buffer accelerates and drains a backlog", () => {
  const buffer = new StreamPacingBuffer();
  buffer.append("字".repeat(200));
  assert.equal(buffer.take().length, 8);
  assert.equal(buffer.length, 192);
  assert.equal(buffer.take(true).length, 192);
  assert.equal(buffer.length, 0);
});

test("incremental pacing buffer catches up after a large input pause", () => {
  const buffer = new StreamPacingBuffer();
  buffer.append("字".repeat(3_000));
  const slice = buffer.take();
  assert.ok(slice.length >= 128 && slice.length <= 512);
  assert.equal(buffer.length, 3_000 - slice.length);
});
