import assert from "node:assert/strict";
import test from "node:test";
import {
  appendConversationWindow,
  conversationTurnPreviews,
  isConversationAtBottom,
  latestConversationWindow,
  prependConversationWindow,
  windowContainingTurn,
} from "../src/conversation-window";

test("detects whether the conversation is showing its real bottom", () => {
  assert.equal(
    isConversationAtBottom({
      scrollHeight: 1_000,
      scrollTop: 400,
      clientHeight: 600,
    }),
    true,
  );
  assert.equal(
    isConversationAtBottom({
      scrollHeight: 1_000,
      scrollTop: 328.5,
      clientHeight: 600,
    }),
    true,
  );
  assert.equal(
    isConversationAtBottom({
      scrollHeight: 1_000,
      scrollTop: 327,
      clientHeight: 600,
    }),
    false,
  );
  assert.equal(
    isConversationAtBottom(
      { scrollHeight: 1_000, scrollTop: 400, clientHeight: 600 },
      true,
    ),
    false,
  );
});

test("conversation window starts on the latest page", () => {
  assert.deepEqual(latestConversationWindow(50, 10), { start: 40, end: 50 });
});

test("conversation window stays bounded while paging backward and forward", () => {
  const older = prependConversationWindow({ start: 40, end: 50 }, 10);
  assert.deepEqual(older, { start: 30, end: 50 });
  assert.deepEqual(prependConversationWindow(older, 10), {
    start: 20,
    end: 40,
  });
  assert.deepEqual(appendConversationWindow({ start: 20, end: 40 }, 50, 10), {
    start: 30,
    end: 50,
  });
});

test("conversation window can reveal a selected turn without mounting all turns", () => {
  assert.deepEqual(windowContainingTurn(15, 80, 12), { start: 15, end: 39 });
  assert.deepEqual(windowContainingTurn(78, 80, 12), { start: 68, end: 80 });
});

test("builds concise hover previews from each turn's assistant reply", () => {
  const turns = conversationTurnPreviews([
    { id: "u1", role: "user", content: "检查   项目结构", createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "已经检查项目。\n发现两个入口文件。",
      createdAt: 2,
    },
    {
      id: "u2",
      role: "user",
      content: "继续处理",
      createdAt: 3,
      queued: true,
    },
  ]);

  assert.deepEqual(turns, [
    {
      id: "u1",
      question: "检查 项目结构",
      answer: "已经检查项目。 发现两个入口文件。",
      messageIndex: 0,
    },
    {
      id: "u2",
      question: "继续处理",
      answer: "消息已排队，等待上一轮完成",
      messageIndex: 2,
    },
  ]);
});

test("removes persisted thinking blocks from hover previews", () => {
  const turns = conversationTurnPreviews([
    { id: "u1", role: "user", content: "检查仓库", createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "<thinking>inspect repository</thinking>当前目录没有 Git。",
      createdAt: 2,
    },
  ]);
  assert.equal(turns[0].answer, "当前目录没有 Git。");
});
