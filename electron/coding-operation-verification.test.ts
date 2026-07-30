import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedCodingOperations,
  claimsNoChangeNeeded,
  hasVerifiedNoChangeEvidence,
  isAdvisoryOnlyRequest,
  missingRequestedCodingOperations,
  requestedCodingOperations,
  shouldRequireCodingTool,
  successfulCodingEvidence,
} from "./coding-operation-verification";

test("keeps explicit no-edit architecture questions out of coding verification", () => {
  const content =
    "你先大概看下，我想加一个手机版，能在手机上控制电脑上，应该怎么做，只说不改";
  assert.equal(isAdvisoryOnlyRequest(content), true);
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        { kind: "message", role: "user", content },
      ]),
    ],
    [],
  );
});

test("does not treat a scoped no-change clause as an advisory-only request", () => {
  const content = "不要修改颜色，把输入框布局优化一下";
  assert.equal(isAdvisoryOnlyRequest(content), false);
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        { kind: "message", role: "user", content },
      ]),
    ],
    ["modify"],
  );
});

test("detects coding work requested and falsely claimed by a text-only reply", () => {
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "整体检查 UI，然后开始修改并验证构建",
        },
      ]),
    ],
    ["inspect", "modify", "validate"],
  );
  assert.deepEqual(
    [
      ...claimedCodingOperations(
        "已完成检查和改造。修改文件：src/App.tsx。类型检查、92 项测试和生产构建通过。",
      ),
    ],
    ["inspect", "modify", "validate"],
  );
});

test("requires structured successful tool results as coding evidence", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        { id: "read", name: "read_file", input: { path: "src/App.tsx" } },
        { id: "edit", name: "apply_patch", input: { patch: "..." } },
        { id: "test", name: "diagnostics", input: { kind: "test" } },
      ],
    },
    { kind: "result" as const, callId: "read", content: '{"success":true}' },
    { kind: "result" as const, callId: "edit", content: '{"success":false}' },
    {
      kind: "result" as const,
      callId: "test",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
  ];
  assert.deepEqual(
    [...successfulCodingEvidence(history)],
    ["inspect", "execute", "validate"],
  );
});

test("detects execution requests and inherits the previous request for continuation replies", () => {
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "检查当前项目，修复输入卡顿并运行测试",
        },
        { kind: "message", role: "assistant", content: "我先开始排查。" },
        { kind: "message", role: "user", content: "继续" },
      ]),
    ],
    ["inspect", "modify", "execute", "validate"],
  );

  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "做一个状态页并启动开发服务",
        },
      ]),
    ],
    ["modify", "execute"],
  );
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "提交到 GitHub 并触发打包",
        },
      ]),
    ],
    [],
  );
});

test("continuation can accept the concrete edits proposed by the assistant", () => {
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        { kind: "message", role: "user", content: "还有哪些地方需要优化？" },
        {
          kind: "message",
          role: "assistant",
          content: "建议修改完成判定、增加真实变更校验，并运行测试。",
        },
        { kind: "message", role: "user", content: "全部改" },
      ]),
    ],
    ["modify", "execute", "validate"],
  );
});

test("does not count successful no-op file tools as modification evidence", () => {
  const noOpHistory = [
    {
      kind: "calls" as const,
      calls: [
        { id: "write", name: "write_file", input: { path: "a.ts" } },
        { id: "patch", name: "apply_patch", input: { patch: "..." } },
        { id: "mkdir", name: "make_directory", input: { path: "src" } },
      ],
    },
    {
      kind: "result" as const,
      callId: "write",
      content:
        '{"success":true,"data":{"changed":false,"diff":"--- a\\n+++ b"}}',
    },
    {
      kind: "result" as const,
      callId: "patch",
      content: '{"success":true,"data":{"changed":false}}',
    },
    {
      kind: "result" as const,
      callId: "mkdir",
      content: '{"success":true,"data":{"changed":false}}',
    },
  ];
  assert.deepEqual([...successfulCodingEvidence(noOpHistory)], []);
  assert.equal(hasVerifiedNoChangeEvidence(noOpHistory), true);
  assert.equal(claimsNoChangeNeeded("文件内容一致，无需修改。"), true);
  assert.equal(claimsNoChangeNeeded("已经修改完成。"), false);
  assert.equal(
    hasVerifiedNoChangeEvidence([
      {
        kind: "calls",
        calls: [{ id: "select", name: "mysql_query", input: {} }],
      },
      {
        kind: "result",
        callId: "select",
        content:
          '{"success":true,"data":{"changed":false,"mutationAttempted":false}}',
      },
    ]),
    false,
  );
  assert.equal(
    hasVerifiedNoChangeEvidence([
      {
        kind: "calls",
        calls: [{ id: "update", name: "mysql_query", input: {} }],
      },
      {
        kind: "result",
        callId: "update",
        content:
          '{"success":true,"data":{"changed":false,"mutationAttempted":true}}',
      },
    ]),
    true,
  );

  const changedHistory = [
    ...noOpHistory,
    {
      kind: "calls" as const,
      calls: [{ id: "changed", name: "write_file", input: { path: "b.ts" } }],
    },
    {
      kind: "result" as const,
      callId: "changed",
      content: '{"success":true,"data":{"changed":true}}',
    },
  ];
  assert.deepEqual([...successfulCodingEvidence(changedHistory)], ["modify"]);
});

test("does not mistake shell redirection or a literal angle bracket for a file edit", () => {
  const evidence = successfulCodingEvidence([
    {
      kind: "calls",
      calls: [
        {
          id: "search",
          name: "run_command",
          input: { command: 'rg ">" src 2>$null' },
        },
      ],
    },
    {
      kind: "result",
      callId: "search",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
  ]);
  assert.equal(evidence.has("inspect"), true);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("modify"), false);
});

test("counts a non-zero command as executed but never as a passing validation", () => {
  const evidence = successfulCodingEvidence([
    {
      kind: "calls",
      calls: [
        {
          id: "command",
          name: "run_command",
          input: { command: "rg missing" },
        },
      ],
    },
    {
      kind: "result",
      callId: "command",
      content: '{"success":false,"data":{"executed":true,"exitCode":1}}',
    },
  ]);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), false);
});

test("recognizes common validation commands without treating run build as an edit", () => {
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        { kind: "message", role: "user", content: "run build" },
      ]),
    ],
    ["execute", "validate"],
  );
  for (const command of [
    "npm run test:unit",
    "bun test",
    "dotnet test",
    "mvn test",
    "./gradlew test",
    "python -m pytest",
  ]) {
    const evidence = successfulCodingEvidence([
      {
        kind: "calls",
        calls: [{ id: command, name: "run_command", input: { command } }],
      },
      {
        kind: "result",
        callId: command,
        content: '{"success":true,"data":{"executed":true}}',
      },
    ]);
    assert.equal(evidence.has("validate"), true, command);
  }
});

test("does not turn coding status questions into execution requests", () => {
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "为什么开发服务启动失败？",
        },
      ]),
    ],
    ["inspect"],
  );
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "为什么启动失败？请修复并重新运行测试",
        },
      ]),
    ],
    ["inspect", "modify", "execute", "validate"],
  );
});

test("requires diagnostics to have actually executed before it proves validation", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "diagnostics", name: "diagnostics", input: { kind: "test" } },
    ],
  };
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        calls,
        {
          kind: "result",
          callId: "diagnostics",
          content: '{"success":true,"data":{"executed":false}}',
        },
      ]),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        calls,
        {
          kind: "result",
          callId: "diagnostics",
          content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
        },
      ]),
    ],
    ["execute", "validate"],
  );
});

test("only accepts validation evidence produced after the latest modification", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "before", name: "diagnostics", input: { kind: "typecheck" } },
      { id: "edit", name: "write_file", input: { path: "src/App.tsx" } },
      { id: "after", name: "diagnostics", input: { kind: "typecheck" } },
    ],
  };
  const beforeEditOnly = successfulCodingEvidence([
    calls,
    {
      kind: "result",
      callId: "before",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
    {
      kind: "result",
      callId: "edit",
      content: '{"success":true,"data":{"changed":true}}',
    },
  ]);
  assert.equal(beforeEditOnly.has("modify"), true);
  assert.equal(beforeEditOnly.has("execute"), true);
  assert.equal(beforeEditOnly.has("validate"), false);

  const validatedAfterEdit = successfulCodingEvidence([
    calls,
    {
      kind: "result",
      callId: "before",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
    {
      kind: "result",
      callId: "edit",
      content: '{"success":true,"data":{"changed":true}}',
    },
    {
      kind: "result",
      callId: "after",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
  ]);
  assert.equal(validatedAfterEdit.has("validate"), true);
});

test("requires process output confirmation before a background process proves execution", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "start", name: "start_process", input: { command: "npm run dev" } },
      { id: "status", name: "process_output", input: { processId: "dev" } },
    ],
  };
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        calls,
        {
          kind: "result",
          callId: "start",
          content: '{"success":true,"data":{"executed":true}}',
        },
      ]),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        calls,
        {
          kind: "result",
          callId: "start",
          content: '{"success":true,"data":{"executed":true}}',
        },
        {
          kind: "result",
          callId: "status",
          content: '{"success":true,"data":{"output":"状态: 运行中"}}',
        },
      ]),
    ],
    ["execute"],
  );
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        calls,
        {
          kind: "result",
          callId: "start",
          content: '{"success":true,"data":{"executed":true}}',
        },
        {
          kind: "result",
          callId: "status",
          content:
            '{"success":true,"data":{"output":"状态: 已退出 (0)","exitCode":0}}',
        },
      ]),
    ],
    [],
  );
});

test("reports which requested coding operations still lack evidence", () => {
  assert.deepEqual(
    missingRequestedCodingOperations(
      new Set(["inspect", "modify", "execute", "validate"]),
      new Set(["inspect", "execute"]),
    ),
    ["modify", "validate"],
  );
});

test("requires successful tools for remote connections and transfers", () => {
  const requested = requestedCodingOperations([
    {
      kind: "message",
      role: "user",
      content: "连接 SSH 服务器，上传本地文件并下载远程日志文件",
    },
  ]);
  assert.deepEqual([...requested], ["connect", "upload", "download"]);
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content: "现在支持连接 SSH 服务器吗？",
        },
      ]),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        {
          kind: "calls",
          calls: [
            { id: "connect", name: "ssh_connect", input: {} },
            { id: "upload", name: "ssh_upload_file", input: {} },
            { id: "download", name: "ssh_download_file", input: {} },
          ],
        },
        { kind: "result", callId: "connect", content: '{"success":true}' },
        { kind: "result", callId: "upload", content: '{"success":true}' },
        { kind: "result", callId: "download", content: '{"success":true}' },
      ]),
    ],
    ["connect", "upload", "download"],
  );
});

test("accepts ordered subagent evidence and invalidates it after a later parent edit", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "child", name: "wait_agent", input: {} },
      { id: "parent", name: "write_file", input: { path: "src/App.tsx" } },
    ],
  };
  const child = {
    kind: "result" as const,
    callId: "child",
    content:
      '{"success":true,"data":{"changed":true,"operationEvidence":["inspect","modify","execute","validate"]}}',
  };
  assert.deepEqual(
    [...successfulCodingEvidence([calls, child])],
    ["inspect", "modify", "execute", "validate"],
  );
  const afterParentEdit = successfulCodingEvidence([
    calls,
    child,
    {
      kind: "result",
      callId: "parent",
      content: '{"success":true,"data":{"changed":true}}',
    },
  ]);
  assert.equal(afterParentEdit.has("validate"), false);
});

test("assistant prose and legacy outputs are not execution evidence", () => {
  assert.deepEqual(
    [
      ...successfulCodingEvidence([
        { kind: "message", role: "assistant", content: "已经修改完成" },
        {
          kind: "calls",
          calls: [{ id: "edit", name: "write_file", input: { path: "a.ts" } }],
        },
        { kind: "result", callId: "edit", content: "修改成功" },
      ]),
    ],
    [],
  );
});

test("requires Kimi K3 to make the first tool call for explicit coding work", () => {
  const requested = new Set(["inspect", "modify"] as const);
  assert.equal(shouldRequireCodingTool("kimi-k3", requested, new Set()), true);
  assert.equal(
    shouldRequireCodingTool("kimi-k3", requested, new Set(["inspect"])),
    true,
  );
  assert.equal(
    shouldRequireCodingTool(
      "kimi-k3",
      requested,
      new Set(["inspect", "modify"]),
    ),
    false,
  );
  assert.equal(
    shouldRequireCodingTool("gpt-5.6-sol", requested, new Set()),
    false,
  );
  assert.equal(shouldRequireCodingTool("kimi-k3", new Set(), new Set()), false);
});
