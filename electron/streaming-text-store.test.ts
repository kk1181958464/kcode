import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamingText,
  consumeStreamingText,
  getStreamingText,
  resetStreamingText,
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