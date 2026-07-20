import assert from "node:assert/strict";
import test from "node:test";
import { compactConversation, estimateMessageTokens } from "../src/context";
import type { AgentActivity, ChatMessage } from "../src/types";

const message = (role: "user" | "assistant", content: string, index: number): ChatMessage => ({ id: String(index), role, content, createdAt: index });

test("estimates image and text context conservatively", () => {
  const plain = estimateMessageTokens([message("user", "a".repeat(300), 1)]);
  const withImage = estimateMessageTokens([{ ...message("user", "a".repeat(300), 1), images: [{ id: "i", name: "i.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AA==", size: 750_000 }] }]);
  assert.equal(plain, 100);
  assert.ok(withImage > plain);
});

test("compacts older messages while retaining the latest turn", () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(index % 2 ? "assistant" : "user", `消息 ${index} ${"内容".repeat(100)}`, index));
  const result = compactConversation({ messages, activities: [] }, 8_000, true);
  assert.ok(result);
  assert.ok(result.compactedMessageCount <= messages.length - 2);
  assert.match(result.contextSummary, /目标与需求|其他上下文/);
  assert.ok(result.contextLedger.goals.length > 0);
});

test("deduplicates repeated tool state in the fact ledger", () => {
  const activities: AgentActivity[] = [1, 2].map((index) => ({ id: String(index), requestId: "r", tool: "write_file", status: "success", title: "修改文件", startedAt: index, completedAt: index + 1, input: {}, path: "src/app.ts" }));
  const messages = Array.from({ length: 4 }, (_, index) => message(index % 2 ? "assistant" : "user", `任务 ${index}`, index));
  const result = compactConversation({ messages, activities }, 8_000, true);
  assert.ok(result);
  assert.deepEqual(result.contextLedger.changedFiles, ["src/app.ts"]);
});

test("does not compact a single conversation turn", () => {
  assert.equal(compactConversation({ messages: [message("user", "问题", 1), message("assistant", "回答", 2)], activities: [] }, 8_000, true), undefined);
});

test("preserves connection credentials through compaction", () => {
  const activities: AgentActivity[] = [{ id: "1", requestId: "r", tool: "ssh_connect", status: "success", title: "连接 SSH", startedAt: 1, completedAt: 2, input: { host: "203.0.113.9", port: 2222, username: "deploy", password: "plain-password" } }];
  const messages = Array.from({ length: 4 }, (_, index) => message(index % 2 ? "assistant" : "user", `任务 ${index}`, index));
  const result = compactConversation({ messages, activities }, 8_000, true);
  assert.ok(result);
  assert.deepEqual(result.contextLedger.connections, ['ssh_connect {"host":"203.0.113.9","port":2222,"username":"deploy","password":"plain-password"}']);
  assert.match(result.contextSummary, /已建立的连接/);
  assert.match(result.contextSummary, /plain-password/);
});

test("carries prior ledger connections forward when compacting again", () => {
  const messages = Array.from({ length: 4 }, (_, index) => message(index % 2 ? "assistant" : "user", `任务 ${index}`, index));
  const result = compactConversation({ messages, activities: [], contextLedger: { goals: [], decisions: [], changedFiles: [], validations: [], failures: [], pending: [], connections: ["SSH root@10.0.0.1:22"] } }, 8_000, true);
  assert.ok(result);
  assert.deepEqual(result.contextLedger.connections, ["SSH root@10.0.0.1:22"]);
});
