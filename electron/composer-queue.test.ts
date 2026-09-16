import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyComposerEnterKey,
  composerModifierKeyLabel,
  prioritizeQueuedInMessages,
  resolveComposerSubmitAction,
} from "../src/composer-queue";
import type { ChatMessage } from "../src/types";

const user = (
  id: string,
  content: string,
  queued = false,
): ChatMessage & { queued?: boolean } => ({
  id,
  role: "user",
  content,
  createdAt: 1,
  queued,
});

test("Enter queues while running and sends when idle", () => {
  assert.equal(
    resolveComposerSubmitAction({ running: true, immediate: false }),
    "queue",
  );
  assert.equal(
    resolveComposerSubmitAction({ running: false, immediate: false }),
    "send",
  );
});

test("modifier+Enter always requests immediate send", () => {
  assert.equal(
    resolveComposerSubmitAction({ running: true, immediate: true }),
    "send-immediate",
  );
  assert.equal(
    resolveComposerSubmitAction({ running: false, immediate: true }),
    "send-immediate",
  );
});

test("classifyComposerEnterKey matches Shift newline and Ctrl/⌘ immediate", () => {
  assert.equal(
    classifyComposerEnterKey({ key: "Enter", shiftKey: true }),
    "none",
  );
  assert.equal(
    classifyComposerEnterKey({ key: "Enter", shiftKey: false }),
    "submit",
  );
  assert.equal(
    classifyComposerEnterKey({
      key: "Enter",
      shiftKey: false,
      ctrlKey: true,
    }),
    "submit-immediate",
  );
  assert.equal(
    classifyComposerEnterKey({
      key: "Enter",
      shiftKey: false,
      metaKey: true,
    }),
    "submit-immediate",
  );
  assert.equal(
    classifyComposerEnterKey({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
    }),
    "none",
  );
  assert.equal(
    classifyComposerEnterKey({
      key: "Enter",
      shiftKey: false,
      keyCode: 229,
    }),
    "none",
  );
});

test("prioritizeQueuedInMessages moves a queued item to the front of the queue", () => {
  const messages: ChatMessage[] = [
    user("u1", "first"),
    { id: "a1", role: "assistant", content: "ok", createdAt: 2 },
    user("q1", "later", true),
    user("q2", "soon", true),
  ];
  const next = prioritizeQueuedInMessages(messages, "q2");
  assert.deepEqual(
    next.map((message) => message.id),
    ["u1", "a1", "q2", "q1"],
  );
});

test("composerModifierKeyLabel follows Mac vs other platforms", () => {
  assert.equal(composerModifierKeyLabel("MacIntel"), "⌘");
  assert.equal(composerModifierKeyLabel("iPhone"), "⌘");
  assert.equal(composerModifierKeyLabel("Win32"), "Ctrl");
  assert.equal(composerModifierKeyLabel("Linux x86_64"), "Ctrl");
});
