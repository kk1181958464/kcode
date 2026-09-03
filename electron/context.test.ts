import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptModelContextSummary,
  boundedContextSource,
  compactConversation,
  containsDurableConnectionDetails,
  containsDurableProtocolDetails,
  contextSummarySource,
  estimateMessageTokens,
  retainedCompactedUserMessages,
  retainedCompactionContext,
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

test("retains compacted SSH credentials outside the redacted summary", () => {
  const messages = [
    message(
      "user",
      'ssh：122.51.15.198 用户名：ubuntu 密码："ssh-secret" 密钥："C:\\Users\\Administrator\\.ssh\\id_ed25519"',
      1,
    ),
    message("assistant", "已连接服务器", 2),
    ...Array.from({ length: 8 }, (_, index) =>
      message(
        index % 2 ? "assistant" : "user",
        `后续工作 ${index} ${"实现细节".repeat(500)}`,
        index + 3,
      ),
    ),
  ];
  const compacted = compactConversation(
    { messages, activities: [] },
    8_000,
    true,
  );
  assert.ok(compacted);
  assert.doesNotMatch(compacted.contextSummary, /ssh-secret/);

  const retained = retainedCompactionContext(
    messages,
    compacted.compactedMessageCount,
    8_000,
  );
  assert.match(retained, /122\.51\.15\.198/);
  assert.match(retained, /ubuntu/);
  assert.match(retained, /ssh-secret/);
  assert.match(retained, /id_ed25519/);
});

test("reserves retention budget for old connection facts", () => {
  const credentials = message(
    "user",
    "服务器地址：203.0.113.7 用户名：admin 密码：correct-horse",
    1,
  );
  const messages = [
    credentials,
    ...Array.from({ length: 12 }, (_, index) =>
      message("user", `普通后续消息 ${index} ${"x".repeat(1_500)}`, index + 2),
    ),
  ];
  const retained = retainedCompactedUserMessages(
    messages,
    messages.length,
    8_000,
  );
  assert.ok(retained.some((item) => item.id === credentials.id));
  assert.match(
    retained.find((item) => item.id === credentials.id)?.content ?? "",
    /correct-horse/,
  );
});

test("does not duplicate credentials that remain in recent context", () => {
  const messages = [
    message("user", "较早任务", 1),
    message("assistant", "较早回复", 2),
    message("user", "SSH：10.0.0.8 用户名：root 密码：recent-secret", 3),
  ];
  const retained = retainedCompactionContext(messages, 2, 8_000);
  assert.doesNotMatch(retained, /recent-secret/);
});

test("does not treat generic login UI copy as connection credentials", () => {
  assert.equal(
    containsDurableConnectionDetails("把用户名和密码输入框的样式改整齐"),
    false,
  );
  assert.equal(
    containsDurableConnectionDetails("用户名：deploy 密码：secret"),
    true,
  );
});

test("retains only complete API protocol contracts", () => {
  assert.equal(
    containsDurableProtocolDetails(
      "请打开 https://example.com/docs，提交一段 JSON 配置并告诉我页面内容。",
    ),
    false,
  );
  assert.equal(
    containsDurableProtocolDetails(
      [
        "Base URL: https://ai-studio.example/v1",
        "请求头 Authorization: Bearer <API_KEY>，请求体使用 JSON",
        "POST /videos/generations 返回 processing，GET /videos/{id} 查询状态",
        "成功响应示例：status=succeeded，data.url 为结果地址",
      ].join("\n"),
    ),
    true,
  );
});

test("keeps protocol tail fields in the retained compaction context", () => {
  const protocol = [
    "接口协议：Base URL https://ai-studio.example/v1",
    "Authorization: Bearer <API_KEY>; Content-Type: application/json",
    "POST /videos/generations，返回 status=processing 和任务 id",
    "GET /videos/{JOB_ID} 查询任务状态，成功响应 status=succeeded",
    "POLL_SUCCESS_STATUS=succeeded; VIDEO_RESULT_URL_FIELD=data.video.url",
  ].join("\n");
  const messages = [
    message("user", protocol, 1),
    ...Array.from({ length: 12 }, (_, index) =>
      message(
        "assistant",
        `中间执行记录 ${index} ${"x".repeat(900)}`,
        index + 2,
      ),
    ),
    message("user", "继续执行", 99),
  ];
  const retained = retainedCompactionContext(
    messages,
    messages.length - 1,
    8_000,
  );
  assert.match(retained, /POLL_SUCCESS_STATUS=succeeded/);
  assert.match(retained, /VIDEO_RESULT_URL_FIELD=data\.video\.url/);
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

test("bounded context source never exceeds a tiny budget", () => {
  const source = "0123456789".repeat(20);
  for (const limit of [0, 1, 8, 32])
    assert.ok(boundedContextSource(source, limit).length <= limit);
});

test("model summary source keeps middle records instead of one global clip", () => {
  const messages = Array.from({ length: 7 }, (_, index) =>
    message("assistant", `record-${index} ${"x".repeat(12_000)}`, index),
  );
  const source = contextSummarySource({ messages, activities: [] }, 7, 8_000);
  for (let index = 0; index < messages.length; index += 1)
    assert.match(source, new RegExp(`record-${index}`));
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
      ledger: {
        ...ledger,
        decisions: ["采用事件驱动状态"],
        changedFiles: ["src/hallucinated.ts"],
        validations: ["模型声称测试通过"],
        failures: ["模型声称失败"],
        connections: ["模型声称已连接"],
      },
    },
    8_000,
  );
  assert.ok(accepted);
  assert.deepEqual(accepted.ledger.decisions, ["采用事件驱动状态"]);
  assert.deepEqual(accepted.ledger.changedFiles, []);
  assert.deepEqual(accepted.ledger.validations, []);
  assert.deepEqual(accepted.ledger.failures, []);
  assert.deepEqual(accepted.ledger.connections, []);
  assert.match(accepted.summary, /清晰的新摘要/);
  assert.doesNotMatch(accepted.summary, /hallucinated|模型声称/);
});

test("keeps prose claims unverified and builds facts from activities", () => {
  const messages = [
    message("user", "检查并修复问题", 1),
    message("assistant", "已经修改 src/fake.ts，测试也通过了", 2),
    message("user", "继续", 3),
    message("assistant", "稍后汇总", 4),
  ];
  const activities: AgentActivity[] = [
    {
      id: "write",
      requestId: "r",
      tool: "write_file",
      status: "success",
      title: "写入文件",
      startedAt: 1,
      completedAt: 2,
      input: {},
      path: "src/real.ts",
      changed: true,
      operationEvidence: ["modify"],
    },
    {
      id: "test",
      requestId: "r",
      tool: "run_command",
      status: "success",
      title: "运行命令",
      startedAt: 3,
      completedAt: 4,
      input: {},
      command: "npm test",
      executed: true,
      operationEvidence: ["execute", "validate"],
    },
  ];
  const result = compactConversation(
    { messages, activities },
    8_000,
    true,
  );
  assert.ok(result);
  assert.deepEqual(result.contextLedger.changedFiles, ["src/real.ts"]);
  assert.deepEqual(result.contextLedger.validations, ["运行命令: success"]);
  assert.ok(
    result.contextLedger.pending.some((item) => item.includes("src/fake.ts")),
  );
  const verifiedSection = result.contextSummary
    .split("## 未验证对话记录与待办")[0];
  assert.doesNotMatch(verifiedSection, /src\/fake\.ts/);
  assert.match(result.contextSummary, /未验证对话记录与待办[\s\S]*src\/fake\.ts/);
});
