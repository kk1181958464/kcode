import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptModelContextSummary,
  boundedContextSource,
  compactConversation,
  contextSummarySource,
  estimateMessageTokens,
} from "../src/context";
import type { AgentActivity, ChatMessage } from "../src/types";

const message = (
  role: "user" | "assistant",
  content: string,
  index: number,
): ChatMessage => ({ id: String(index), role, content, createdAt: index });

test("estimates image and text context conservatively", () => {
  const plain = estimateMessageTokens([message("user", "a".repeat(300), 1)]);
  const withImage = estimateMessageTokens([
    {
      ...message("user", "a".repeat(300), 1),
      images: [
        {
          id: "i",
          name: "i.png",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
          size: 750_000,
        },
      ],
    },
  ]);
  assert.equal(plain, 100);
  assert.ok(withImage > plain);
});

test("compacts older messages while retaining the latest turn", () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(
      index % 2 ? "assistant" : "user",
      `消息 ${index} ${"内容".repeat(100)}`,
      index,
    ),
  );
  const result = compactConversation({ messages, activities: [] }, 8_000, true);
  assert.ok(result);
  assert.ok(result.compactedMessageCount <= messages.length - 2);
  assert.match(result.contextSummary, /目标与需求|其他上下文/);
  assert.ok(result.contextLedger.goals.length > 0);
});

test("deduplicates repeated tool state in the fact ledger", () => {
  const activities: AgentActivity[] = [1, 2].map((index) => ({
    id: String(index),
    requestId: "r",
    tool: "write_file",
    status: "success",
    title: "修改文件",
    startedAt: index,
    completedAt: index + 1,
    input: {},
    path: "src/app.ts",
  }));
  const messages = Array.from({ length: 4 }, (_, index) =>
    message(index % 2 ? "assistant" : "user", `任务 ${index}`, index),
  );
  const result = compactConversation({ messages, activities }, 8_000, true);
  assert.ok(result);
  assert.deepEqual(result.contextLedger.changedFiles, ["src/app.ts"]);
});

test("does not compact a single conversation turn", () => {
  assert.equal(
    compactConversation(
      {
        messages: [message("user", "问题", 1), message("assistant", "回答", 2)],
        activities: [],
      },
      8_000,
      true,
    ),
    undefined,
  );
});

test("preserves connection coordinates but redacts credentials", () => {
  const activities: AgentActivity[] = [
    {
      id: "1",
      requestId: "r",
      tool: "ssh_connect",
      status: "success",
      title: "连接 SSH",
      startedAt: 1,
      completedAt: 2,
      input: {
        host: "203.0.113.9",
        port: 2222,
        username: "deploy",
        password: "plain-password",
      },
    },
  ];
  const messages = Array.from({ length: 4 }, (_, index) =>
    message(index % 2 ? "assistant" : "user", `任务 ${index}`, index),
  );
  const result = compactConversation({ messages, activities }, 8_000, true);
  assert.ok(result);
  assert.deepEqual(result.contextLedger.connections, [
    'ssh_connect {"host":"203.0.113.9","port":2222,"username":"deploy","password":"[已隐藏]"}',
  ]);
  assert.match(result.contextSummary, /已建立的连接/);
  assert.doesNotMatch(result.contextSummary, /plain-password/);
});

test("carries prior ledger connections forward when compacting again", () => {
  const messages = Array.from({ length: 4 }, (_, index) =>
    message(index % 2 ? "assistant" : "user", `任务 ${index}`, index),
  );
  const result = compactConversation(
    {
      messages,
      activities: [],
      contextLedger: {
        goals: [],
        decisions: [],
        changedFiles: [],
        validations: [],
        failures: [],
        pending: [],
        connections: ["SSH root@10.0.0.1:22"],
      },
    },
    8_000,
    true,
  );
  assert.ok(result);
  assert.deepEqual(result.contextLedger.connections, ["SSH root@10.0.0.1:22"]);
});

test("redacts credentials already present in an older ledger", () => {
  const messages = Array.from({ length: 4 }, (_, index) =>
    message(index % 2 ? "assistant" : "user", `任务 ${index}`, index),
  );
  const result = compactConversation(
    {
      messages,
      activities: [],
      contextLedger: {
        goals: [],
        decisions: [],
        changedFiles: [],
        validations: [],
        failures: [],
        pending: [],
        connections: [
          'ssh_connect {"host":"10.0.0.1","password":"old-secret"}',
        ],
      },
    },
    8_000,
    true,
  );
  assert.ok(result);
  assert.doesNotMatch(result.contextSummary, /old-secret/);
  assert.doesNotMatch(
    result.contextLedger.connections.join("\n"),
    /old-secret/,
  );
});

test("builds the model summary source from original messages", () => {
  const messages = [
    message("user", "保留最开始的真实需求", 1),
    message("assistant", "中间实施细节", 2),
    message("user", "最后的约束条件", 3),
    message("assistant", "最近回复不应进入摘要", 4),
  ];
  const source = contextSummarySource(
    { messages, activities: [], contextSummary: "上一轮摘要" },
    3,
    8_000,
  );
  assert.match(source, /上一轮摘要/);
  assert.match(source, /保留最开始的真实需求/);
  assert.match(source, /最后的约束条件/);
  assert.doesNotMatch(source, /最近回复不应进入摘要/);
});

test("bounded summary source retains both ends", () => {
  const source = `HEAD-${"x".repeat(200)}-TAIL`;
  const bounded = boundedContextSource(source, 100);
  assert.ok(bounded.startsWith("HEAD-"));
  assert.ok(bounded.endsWith("-TAIL"));
  assert.match(bounded, /中间较早内容/);
});

test("rejects repeated or excessively bloated model summaries", () => {
  const ledger = {
    goals: ["目标"],
    decisions: [],
    changedFiles: [],
    validations: [],
    failures: [],
    pending: [],
    connections: [],
  };
  const local = {
    contextSummary: "简洁摘要",
    contextLedger: ledger,
    compactedMessageCount: 3,
  };
  const repeated = Array.from(
    { length: 12 },
    () => "完全相同的重复摘要内容",
  ).join("\n");
  assert.equal(
    acceptModelContextSummary(local, { summary: repeated, ledger }, 8_000),
    undefined,
  );
  const accepted = acceptModelContextSummary(
    local,
    {
      summary: "清晰的新摘要",
      ledger: { ...ledger, changedFiles: ["src/app.ts"] },
    },
    8_000,
  );
  assert.ok(accepted);
  assert.deepEqual(accepted.ledger.changedFiles, ["src/app.ts"]);
});
