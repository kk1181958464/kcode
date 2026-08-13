import assert from "node:assert/strict";
import test from "node:test";
import {
  appendStreamingText,
  consumeStreamingText,
  getStreamingText,
  getStreamingTextRevision,
  getStreamingTextTail,
  replaceStreamingText,
  resetStreamingText,
  streamingProgressKey,
  subscribeStreamingText,
} from "../src/streaming-text-store";

test("streaming text store appends text and notifies only its request", () => {
  let firstNotifications = 0;
  let secondNotifications = 0;
  const firstChanges: unknown[] = [];
  const unsubscribeFirst = subscribeStreamingText("first", (change) => {
    firstNotifications += 1;
    firstChanges.push(change);
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
  assert.equal(firstNotifications, 3);
  assert.deepEqual(firstChanges.at(-1), { type: "reset" });

  appendStreamingText("first", "重试文本");
  resetStreamingText("first");
  assert.equal(getStreamingText("first"), "");
  assert.equal(firstNotifications, 5);

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

test("consuming settled text clears the mounted streaming tail", () => {
  const changes: unknown[] = [];
  const unsubscribe = subscribeStreamingText("settled", (change) =>
    changes.push(change),
  );

  appendStreamingText("settled", "已经显示在步骤上方的正文");
  assert.equal(consumeStreamingText("settled"), "已经显示在步骤上方的正文");
  assert.deepEqual(changes.at(-1), { type: "reset" });
  assert.equal(getStreamingText("settled"), "");

  unsubscribe();
});

test("settled text can be handed to React without clearing the live DOM first", () => {
  const changes: unknown[] = [];
  const unsubscribe = subscribeStreamingText("handoff", (change) =>
    changes.push(change),
  );

  const previousRevision = getStreamingTextRevision("handoff");
  appendStreamingText("handoff", "先保留到下一次 React 提交");
  assert.equal(
    consumeStreamingText("handoff", { emitReset: false }),
    "先保留到下一次 React 提交",
  );
  assert.deepEqual(changes, [
    { type: "append", delta: "先保留到下一次 React 提交" },
  ]);
  assert.equal(getStreamingText("handoff"), "");
  assert.equal(getStreamingTextRevision("handoff"), previousRevision + 1);

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
