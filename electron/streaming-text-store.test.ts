import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamingText,
  consumeStreamingText,
  getStreamingText,
  getStreamingTextTail,
  replaceStreamingText,
  resetStreamingText,
  streamingProgressKey,
  subscribeStreamingText,
} from "../src/streaming-text-store";

test("streaming text store appends text and notifies only its request", () => {
  let firstNotifications = 0;
  let secondNotifications = 0;
  const unsubscribeFirst = subscribeStreamingText("first", () => {
    firstNotifications += 1;
  });
  const unsubscribeSecond = subscribeStreamingText("second", () => {
    secondNotifications += 1;
  });

  appendStreamingText("first", "你");
  appendStreamingText("first", "好");

  assert.equal(getStreamingText("first"), "你好");
  assert.equal(firstNotifications, 2);
  assert.equal(secondNotifications, 0);

  assert.equal(consumeStreamingText("first"), "你好");
  assert.equal(getStreamingText("first"), "");
  assert.equal(firstNotifications, 2);

  appendStreamingText("first", "重试文本");
  resetStreamingText("first");
  assert.equal(getStreamingText("first"), "");
  assert.equal(firstNotifications, 4);

  unsubscribeFirst();
  unsubscribeSecond();
});

test("streaming progress replaces the current status instead of appending history", () => {
  const key = streamingProgressKey("request");
  const changes: unknown[] = [];
  const unsubscribe = subscribeStreamingText(key, (change) =>
    changes.push(change),
  );
  replaceStreamingText(key, "等待首个响应");
  replaceStreamingText(key, "断流后正在重连");
  assert.equal(getStreamingText(key), "断流后正在重连");
  assert.deepEqual(changes.at(-1), {
    type: "replace",
    value: "断流后正在重连",
  });
  resetStreamingText(key);
  unsubscribe();
});

test("returns a bounded streaming tail without losing the full value", () => {
  appendStreamingText("long", "开头😀");
  appendStreamingText("long", "中间".repeat(3_000));
  appendStreamingText("long", "结尾");
  const tail = getStreamingTextTail("long", 10);
  assert.equal(tail.totalLength, getStreamingText("long").length);
  assert.equal(tail.text.endsWith("结尾"), true);
  assert.equal(tail.text.length <= 11, true);
  assert.equal(consumeStreamingText("long").startsWith("开头😀"), true);
});
