import test from "node:test";
import assert from "node:assert/strict";
import {
  createConversationIsolation,
  historyFingerprint,
} from "./conversation-isolation";

test("creates stable and distinct conversation isolation identifiers", () => {
  const first = createConversationIsolation("task-a", "request-1");
  const sameRun = createConversationIsolation("task-a", "request-1");
  const nextRun = createConversationIsolation("task-a", "request-2");
  const otherTask = createConversationIsolation("task-b", "request-3");
  assert.equal(first.conversationId, sameRun.conversationId);
  assert.equal(first.taskScopeId, nextRun.taskScopeId);
  assert.notEqual(first.conversationId, nextRun.conversationId);
  assert.notEqual(first.traceId, nextRun.traceId);
  assert.notEqual(first.taskScopeId, otherTask.taskScopeId);
  assert.notEqual(first.conversationId, otherTask.conversationId);
  assert.equal(first.headers["X-KCode-Conversation-Id"], first.conversationId);
  assert.deepEqual(first.openAi, {
    user: first.conversationId,
    store: false,
  });
  assert.match(first.boundary, new RegExp(first.conversationId));
  assert.doesNotMatch(first.conversationId, /task-a/);
});

test("fingerprints request history without retaining its contents", () => {
  const fingerprint = historyFingerprint([
    { role: "user", content: "private conversation text" },
  ]);
  assert.match(fingerprint, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(fingerprint, /private/);
});
