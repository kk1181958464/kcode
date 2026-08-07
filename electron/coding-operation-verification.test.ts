import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedCodingOperations,
  claimsTaskCompletion,
  claimsNoChangeNeeded,
  compactOperationEvidenceResult,
  hasRequestedUserInputEvidence,
  hasSuccessfulToolEvidence,
  hasVerifiedNoChangeEvidence,
  hasVerifiedNoChangeReport,
  isAdvisoryOnlyRequest,
  isUnsupportedTaskCompletionClaim,
  missingRequestedCodingOperations,
  relevantVerificationRequestContent,
  reportsBlockedCodingOperations,
  reportsMissingRequiredUserInput,
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

test("ignores recovery metadata when classifying an informational request", () => {
  const observation = "我看配置-接码里面没有设置的地方";
  const recovery =
    "<interrupted_turn_recovery>先核对现状，再完成剩余步骤；不要重复已经完成的修改，也不要假定尚未验证的步骤已经完成。</interrupted_turn_recovery>";
  const history = [
    {
      kind: "message" as const,
      role: "user" as const,
      content: "没有价格限制吗？最高验证码不能超过多少钱？",
    },
    {
      kind: "message" as const,
      role: "assistant" as const,
      content: "我先检查。",
    },
    {
      kind: "message" as const,
      role: "user" as const,
      content: `${observation}\n\n${recovery}`,
    },
  ];

  assert.equal(relevantVerificationRequestContent(history), observation);
  assert.deepEqual([...requestedCodingOperations(history)], []);
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        ...history.slice(0, -1),
        { kind: "message", role: "user", content: recovery } as const,
      ]),
    ],
    [],
  );
});

test("keeps explicit configuration changes actionable after sanitizing metadata", () => {
  const content =
    '把配置-接码页面增加最高价格输入框并运行测试\n\n<context_file name="notes.txt">这里只是附件内容，不要修改验证</context_file>';
  assert.deepEqual(
    [
      ...requestedCodingOperations([
        { kind: "message", role: "user", content },
      ]),
    ],
    ["modify", "execute", "validate"],
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
  assert.deepEqual(
    [...claimedCodingOperations("我修改了 src/App.tsx，并运行了构建。")],
    ["modify", "execute"],
  );
  assert.deepEqual(
    [
      ...claimedCodingOperations(
        "SSH 服务器已连接，文件上传成功，远程日志下载完成。",
      ),
    ],
    ["connect", "upload", "download"],
  );
  assert.deepEqual(
    [
      ...claimedCodingOperations(
        "尚未修改文件，无法连接服务器，也没有上传或下载任何内容。",
      ),
    ],
    [],
  );
  assert.deepEqual(
    [...claimedCodingOperations("检查后确认当前实现正确，无需修改。")],
    ["inspect"],
  );
  assert.deepEqual(
    [...claimedCodingOperations("如果修改了文件，就需要重新运行测试。")],
    [],
  );
  assert.deepEqual(
    missingRequestedCodingOperations(
      claimedCodingOperations("我修改了配置文件。"),
      new Set(),
    ),
    ["modify"],
  );
});

test("requires successful tool evidence only when a task requested execution", () => {
  assert.equal(claimsTaskCompletion("任务已完成，问题已经解决。"), true);
  assert.equal(
    claimsTaskCompletion("任务尚未完成，目前只处理了一部分。"),
    false,
  );
  assert.equal(hasSuccessfulToolEvidence([]), false);
  assert.equal(
    isUnsupportedTaskCompletionClaim("回答已完成。", false, []),
    false,
  );
  assert.equal(
    isUnsupportedTaskCompletionClaim("任务已完成。", true, []),
    true,
  );
  assert.equal(
    hasSuccessfulToolEvidence([
      {
        kind: "calls",
        calls: [{ id: "failed", name: "run_command", input: {} }],
      },
      {
        kind: "result",
        callId: "failed",
        content: '{"success":false,"data":{"executed":true,"exitCode":1}}',
      },
    ]),
    false,
  );
  assert.equal(
    hasSuccessfulToolEvidence([
      {
        kind: "calls",
        calls: [{ id: "read", name: "read_file", input: {} }],
      },
      { kind: "result", callId: "read", content: '{"success":true}' },
    ]),
    true,
  );
  assert.equal(
    isUnsupportedTaskCompletionClaim("任务已完成。", true, [
      {
        kind: "calls",
        calls: [{ id: "read", name: "read_file", input: {} }],
      },
      { kind: "result", callId: "read", content: '{"success":true}' },
    ]),
    false,
  );
  assert.equal(
    hasSuccessfulToolEvidence([
      {
        kind: "calls",
        calls: [{ id: "question", name: "request_user_input", input: {} }],
      },
      {
        kind: "result",
        callId: "question",
        content: '{"success":true}',
      },
    ]),
    false,
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

  assert.deepEqual(
    [
      ...requestedCodingOperations([
        {
          kind: "message",
          role: "user",
          content:
            "我的页面，右上角门店标签改为切换门店，点击后弹窗，输入账号密码，直接登录另一个账号",
        },
      ]),
    ],
    ["modify"],
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
  assert.equal(claimsNoChangeNeeded("本轮没有文件修改需求。"), true);
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

test("accepts an explicit no-change report only after successful inspection", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        {
          id: "inspect",
          name: "ssh_run",
          input: { command: "Get-Content /tmp/jobs.json" },
        },
      ],
    },
    {
      kind: "result" as const,
      callId: "inspect",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
    {
      kind: "calls" as const,
      calls: [
        {
          id: "no-change",
          name: "report_no_change",
          input: {
            reason: "服务器队列状态正常，工作区中没有需要修改的配置目标。",
          },
        },
      ],
    },
    {
      kind: "result" as const,
      callId: "no-change",
      content:
        '{"success":true,"data":{"changed":false,"noChangeReported":true}}',
    },
  ];
  const evidence = successfulCodingEvidence(history);
  assert.deepEqual([...evidence], ["execute", "inspect"]);
  assert.equal(hasVerifiedNoChangeEvidence(history), true);
  assert.equal(hasVerifiedNoChangeReport(history), true);
  assert.equal(
    claimsNoChangeNeeded("只读检查已确认当前状态正确，因此本次不修改配置。"),
    true,
  );
  assert.deepEqual(
    missingRequestedCodingOperations(
      new Set(["inspect", "modify", "validate"]),
      evidence,
    ).filter((operation) => {
      if (operation === "modify") return !hasVerifiedNoChangeEvidence(history);
      if (operation === "validate") return !hasVerifiedNoChangeReport(history);
      return true;
    }),
    [],
  );
});

test("preserves an explicit no-change report in the compact evidence ledger", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        { id: "inspect", name: "git_status", input: {} },
        {
          id: "no-change",
          name: "report_no_change",
          input: {
            reason:
              "测试已执行，失败项仅依赖本机未配置的外部服务，工作区没有修改目标。",
          },
        },
      ],
    },
    compactOperationEvidenceResult("inspect", "git_status", true, {
      output: "工作区无修改",
    }),
    compactOperationEvidenceResult("no-change", "report_no_change", true, {
      changed: false,
      noChangeReported: true,
    }),
  ];

  assert.equal(hasVerifiedNoChangeEvidence(history), true);
  assert.equal(hasVerifiedNoChangeReport(history), true);
  assert.deepEqual(
    missingRequestedCodingOperations(
      new Set(["inspect", "modify", "validate"]),
      successfulCodingEvidence(history),
    ).filter((operation) => {
      if (operation === "modify") return !hasVerifiedNoChangeEvidence(history);
      if (operation === "validate") return !hasVerifiedNoChangeReport(history);
      return true;
    }),
    [],
  );
});

test("rejects an unsupported no-change report and one made after mutation", () => {
  const reportCall = {
    kind: "calls" as const,
    calls: [
      {
        id: "no-change",
        name: "report_no_change",
        input: { reason: "检查后确认没有可执行的修改目标。" },
      },
    ],
  };
  const reportResult = {
    kind: "result" as const,
    callId: "no-change",
    content:
      '{"success":true,"data":{"changed":false,"noChangeReported":true}}',
  };
  assert.equal(hasVerifiedNoChangeEvidence([reportCall, reportResult]), false);
  assert.equal(
    hasVerifiedNoChangeEvidence([
      {
        kind: "calls",
        calls: [{ id: "read", name: "read_file", input: { path: "a.ts" } }],
      },
      { kind: "result", callId: "read", content: '{"success":true}' },
      {
        kind: "calls",
        calls: [{ id: "edit", name: "write_file", input: { path: "a.ts" } }],
      },
      {
        kind: "result",
        callId: "edit",
        content: '{"success":true,"data":{"changed":true}}',
      },
      reportCall,
      reportResult,
    ]),
    false,
  );
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
    "node --check agreement/agreement.js",
    "php -l app/Controller.php",
    "python -m json.tool package.json",
    "Get-Content package.json -Raw | ConvertFrom-Json",
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

test("accepts successful post-edit validation executed through SSH", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "edit",
        name: "write_file",
        input: { path: ".remote-edit/app.js" },
      },
      {
        id: "upload",
        name: "ssh_upload_file",
        input: {
          localPath: ".remote-edit/app.js",
          remotePath: "/var/www/app/app.js",
        },
      },
      {
        id: "remote-check",
        name: "ssh_run",
        input: {
          command:
            "cd /var/www/app && node --check app.js && Get-Content package.json -Raw | ConvertFrom-Json",
        },
      },
    ],
  };
  const evidence = successfulCodingEvidence([
    calls,
    {
      kind: "result",
      callId: "edit",
      content: '{"success":true,"data":{"changed":true}}',
    },
    {
      kind: "result",
      callId: "upload",
      content: '{"success":true,"data":{"changed":true}}',
    },
    {
      kind: "result",
      callId: "remote-check",
      content: '{"success":true,"data":{"executed":true,"exitCode":0}}',
    },
  ]);
  assert.equal(evidence.has("modify"), true);
  assert.equal(evidence.has("upload"), true);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), true);
});

test("does not accept a failed SSH syntax check as validation", () => {
  const evidence = successfulCodingEvidence([
    {
      kind: "calls",
      calls: [
        {
          id: "remote-check",
          name: "ssh_run",
          input: { command: "node --check broken.js" },
        },
      ],
    },
    {
      kind: "result",
      callId: "remote-check",
      content: '{"success":false,"data":{"executed":true,"exitCode":1}}',
    },
  ]);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), false);
});

test("accepts an explicit pass marker from a custom validation script", () => {
  const evidence = successfulCodingEvidence([
    {
      kind: "calls",
      calls: [
        {
          id: "custom-check",
          name: "run_command",
          input: { command: "node $scriptPath $root" },
        },
      ],
    },
    {
      kind: "result",
      callId: "custom-check",
      content: JSON.stringify({
        success: true,
        data: {
          executed: true,
          exitCode: 0,
          output: "VALIDATE PASS: 页面文件与 WXML 结构均通过校验。",
        },
      }),
    },
  ]);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), true);
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

test("treats missing SSH details as a blocked remote deployment", () => {
  const requested = requestedCodingOperations([
    {
      kind: "message",
      role: "user",
      content: "部署到服务器运行起来，用 IP 访问",
    },
  ]);
  assert.deepEqual([...requested], ["execute", "connect"]);
  const missing = missingRequestedCodingOperations(requested, new Set());
  assert.equal(
    reportsBlockedCodingOperations(
      "尚未收到目标服务器的 SSH 地址、用户名和密钥，无法执行连接和部署，请提供这些信息。",
      missing,
    ),
    true,
  );
  assert.equal(
    reportsBlockedCodingOperations(
      "服务器已经连接并部署完成，但还可以补充 SSH 信息。",
      missing,
    ),
    false,
  );
  assert.equal(
    reportsBlockedCodingOperations(
      "由于没有 SSH 私钥，未能成功连接服务器，部署尚未执行。",
      missing,
    ),
    true,
  );
  assert.equal(
    reportsBlockedCodingOperations("缺少服务器 SSH 信息，无法继续。", [
      "modify",
      "execute",
    ]),
    false,
  );
  assert.equal(
    reportsBlockedCodingOperations(
      "缺少需要修改的接口字段，请提供字段名称和返回格式后我再继续。",
      ["inspect", "modify", "validate"],
    ),
    true,
  );
});

test("recognizes explicit requests for concrete missing user input", () => {
  assert.equal(
    reportsMissingRequiredUserInput(
      "尚未提供登录网址和账号，请补充这些信息后我再继续操作。",
    ),
    true,
  );
  assert.equal(
    reportsMissingRequiredUserInput(
      "Please provide the repository URL and access token before I continue.",
    ),
    true,
  );
  assert.equal(
    reportsMissingRequiredUserInput("我现在不能修改，之后再说。"),
    false,
  );
});

test("preserves a structured user-input request in the evidence ledger", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        {
          id: "need-input",
          name: "request_user_input",
          input: {
            question: "请提供目标服务器的连接信息。",
            fields: ["SSH 地址", "用户名", "密钥"],
          },
        },
      ],
    },
    compactOperationEvidenceResult("need-input", "request_user_input", true, {
      userInputRequested: true,
    }),
  ];

  assert.equal(hasRequestedUserInputEvidence(history), true);
  assert.equal(
    hasRequestedUserInputEvidence([
      history[0],
      compactOperationEvidenceResult("need-input", "request_user_input", true, {
        userInputRequested: false,
      }),
    ]),
    false,
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
