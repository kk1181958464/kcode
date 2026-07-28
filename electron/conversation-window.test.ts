import assert from "node:assert/strict";
import test from "node:test";
import {
  appendConversationWindow,
  latestConversationWindow,
  prependConversationWindow,
  windowContainingTurn,
} from "../src/conversation-window";

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