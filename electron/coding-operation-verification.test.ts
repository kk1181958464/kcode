import assert from "node:assert/strict";
import test from "node:test";
import {
  codingOperationsRequiredByCalls,
  codingOperationsRequiringToolEvidence,
  compactOperationEvidenceResult,
  hasRequestedUserInputEvidence,
  hasSuccessfulToolEvidence,
  hasVerifiedNoChangeEvidence,
  hasVerifiedNoChangeReport,
  isInspectionCommand,
  isValidationCommand,
  latestUserRequestContent,
  missingRequestedCodingOperations,
  missingVerifiedCodingOperations,
  shouldRequireCodingTool,
  structuredToolEvidenceSummary,
  successfulCodingEvidence,
  type CodingOperation,
  type CodingVerificationHistoryItem,
} from "./coding-operation-verification";

test("derives required work only from native tool calls", () => {
  assert.deepEqual(
    [
      ...codingOperationsRequiredByCalls([
        { name: "read_file" },
        { name: "apply_patch" },
        { name: "diagnostics" },
        { name: "ssh_connect" },
        { name: "ssh_upload_file" },
        { name: "ssh_download_file" },
      ]),
    ],
    ["modify", "execute", "validate", "connect", "upload", "download"],
  );
});

test("requires successful evidence for explicitly classified validation commands", () => {
  assert.deepEqual(
    [
      ...codingOperationsRequiredByCalls([
        {
          name: "ssh_run",
          input: { command: "./custom-smoke-check", purpose: "validate" },
        },
      ]),
    ],
    ["execute", "validate"],
  );
});

test("uses only the latest real user payload without interpreting prose", () => {
  const history: CodingVerificationHistoryItem[] = [
    { kind: "message", role: "user", content: "修改并测试项目" },
    { kind: "message", role: "assistant", content: "我会修改、测试并提交" },
    {
      kind: "message",
      role: "user",
      content:
        "<runtime_verification>internal</runtime_verification><user_steer>只回答当前状态</user_steer>",
    },
  ];
  assert.equal(latestUserRequestContent(history), "只回答当前状态");
});

test("recognizes validation executables and shell wrappers structurally", () => {
  for (const command of [
    "npm run test:unit",
    "bun test",
    "dotnet test",
    "mvn test",
    "./gradlew test",
    "python -m pytest",
    "node --check agreement/agreement.js",
    "php -l app/Controller.php",
    'for f in app/*.php; do php -l "$f" || exit 1; done',
    "python -m json.tool package.json",
    "Get-Content package.json -Raw | ConvertFrom-Json",
    'powershell -Command "npm run typecheck"',
  ])
    assert.equal(isValidationCommand(command), true, command);
});

test("does not infer validation from arguments or output-like prose", () => {
  for (const command of [
    'Write-Output "tests passed"',
    'echo "npm test"',
    "node -e \"console.log('validation success')\"",
    "node $scriptPath $root",
    'for f in app/*.php; do php -l "$f"; done',
    'if php -l app/Controller.php; then echo valid; fi',
  ])
    assert.equal(isValidationCommand(command), false, command);
});

test("recognizes inspection executables without matching echoed command text", () => {
  for (const command of [
    "rg -n TODO src",
    "Get-Content package.json",
    "git status --short",
    'pwsh -Command "git diff --stat"',
  ])
    assert.equal(isInspectionCommand(command), true, command);
  for (const command of [
    'Write-Output "git status"',
    'echo "Get-Content package.json"',
  ])
    assert.equal(isInspectionCommand(command), false, command);
});

test("requires structured successful mutation evidence", () => {
  const history: CodingVerificationHistoryItem[] = [
    {
      kind: "calls",
      calls: [{ id: "edit", name: "write_file", input: { path: "a.ts" } }],
    },
    compactOperationEvidenceResult("edit", "write_file", true, {
      changed: true,
      path: "a.ts",
      additions: 2,
      deletions: 1,
    }),
  ];
  assert.deepEqual([...successfulCodingEvidence(history)], ["modify"]);
  assert.equal(hasSuccessfulToolEvidence(history), true);
  assert.deepEqual(structuredToolEvidenceSummary(history), {
    toolCalls: 1,
    successfulTools: 1,
    failedTools: 0,
    changedFiles: ["a.ts"],
    additions: 2,
    deletions: 1,
  });
});

test("assistant prose and legacy result text are never operation evidence", () => {
  const history: CodingVerificationHistoryItem[] = [
    { kind: "message", role: "assistant", content: "已经修改并测试成功" },
    {
      kind: "calls",
      calls: [
        { id: "edit", name: "write_file", input: { path: "a.ts" } },
        {
          id: "custom",
          name: "run_command",
          input: { command: "node $scriptPath" },
        },
      ],
    },
    { kind: "result", callId: "edit", content: "修改成功" },
    compactOperationEvidenceResult("custom", "run_command", true, {
      executed: true,
      exitCode: 0,
      output: "VALIDATION PASS",
    }),
  ];
  const evidence = successfulCodingEvidence(history);
  assert.equal(evidence.has("modify"), false);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), false);
});

test("accepts explicit operation evidence emitted by a successful command", () => {
  const history: CodingVerificationHistoryItem[] = [
    {
      kind: "calls",
      calls: [
        {
          id: "check",
          name: "run_command",
          input: { command: "node $scriptPath" },
        },
      ],
    },
    compactOperationEvidenceResult("check", "run_command", true, {
      executed: true,
      exitCode: 0,
      operationEvidence: ["execute", "validate"],
    }),
  ];
  assert.deepEqual(
    [...successfulCodingEvidence(history)],
    ["execute", "validate"],
  );
});

test("only accepts validation after the latest mutation", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "before", name: "diagnostics", input: { kind: "typecheck" } },
      { id: "edit", name: "write_file", input: { path: "src/App.tsx" } },
      { id: "after", name: "diagnostics", input: { kind: "typecheck" } },
    ],
  };
  const beforeOnly = successfulCodingEvidence([
    calls,
    compactOperationEvidenceResult("before", "diagnostics", true, {
      executed: true,
      exitCode: 0,
    }),
    compactOperationEvidenceResult("edit", "write_file", true, {
      changed: true,
    }),
  ]);
  assert.equal(beforeOnly.has("validate"), false);

  const after = successfulCodingEvidence([
    calls,
    compactOperationEvidenceResult("before", "diagnostics", true, {
      executed: true,
      exitCode: 0,
    }),
    compactOperationEvidenceResult("edit", "write_file", true, {
      changed: true,
    }),
    compactOperationEvidenceResult("after", "diagnostics", true, {
      executed: true,
      exitCode: 0,
    }),
  ]);
  assert.equal(after.has("validate"), true);
});

test("a failed command is execution evidence but not validation", () => {
  const history: CodingVerificationHistoryItem[] = [
    {
      kind: "calls",
      calls: [
        { id: "test", name: "run_command", input: { command: "npm test" } },
      ],
    },
    compactOperationEvidenceResult("test", "run_command", false, {
      executed: true,
      exitCode: 1,
      operationEvidence: ["execute"],
    }),
  ];
  const evidence = successfulCodingEvidence(history);
  assert.equal(evidence.has("execute"), true);
  assert.equal(evidence.has("validate"), false);
});

test("accepts a no-change report only after successful inspection", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "read", name: "read_file", input: { path: "a.ts" } },
      {
        id: "report",
        name: "report_no_change",
        input: { reason: "目标代码已经符合要求，无需修改。" },
      },
    ],
  };
  const history: CodingVerificationHistoryItem[] = [
    calls,
    compactOperationEvidenceResult("read", "read_file", true, {}),
    compactOperationEvidenceResult("report", "report_no_change", true, {
      changed: false,
      noChangeReported: true,
    }),
  ];
  assert.equal(hasVerifiedNoChangeEvidence(history), true);
  assert.equal(hasVerifiedNoChangeReport(history), true);
  assert.deepEqual(
    missingVerifiedCodingOperations(new Set(["modify"]), new Set(), history),
    [],
  );
});

test("rejects a no-change report without inspection", () => {
  const history: CodingVerificationHistoryItem[] = [
    {
      kind: "calls",
      calls: [
        {
          id: "report",
          name: "report_no_change",
          input: { reason: "目标代码已经符合要求，无需修改。" },
        },
      ],
    },
    compactOperationEvidenceResult("report", "report_no_change", true, {
      noChangeReported: true,
    }),
  ];
  assert.equal(hasVerifiedNoChangeEvidence(history), false);
});

test("requires structured user-input evidence", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "input",
        name: "request_user_input",
        input: { question: "请提供目标服务器地址。", fields: ["服务器地址"] },
      },
    ],
  };
  assert.equal(
    hasRequestedUserInputEvidence([
      calls,
      compactOperationEvidenceResult("input", "request_user_input", true, {
        userInputRequested: true,
      }),
    ]),
    true,
  );
});

test("carries ordered subagent evidence and invalidates stale validation", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "child", name: "wait_agent", input: {} },
      { id: "parent", name: "write_file", input: { path: "src/App.tsx" } },
    ],
  };
  const child = compactOperationEvidenceResult("child", "wait_agent", true, {
    changed: true,
    operationEvidence: ["inspect", "modify", "execute", "validate"],
  });
  assert.deepEqual(
    [...successfulCodingEvidence([calls, child])],
    ["inspect", "modify", "execute", "validate"],
  );
  const afterParentEdit = successfulCodingEvidence([
    calls,
    child,
    compactOperationEvidenceResult("parent", "write_file", true, {
      changed: true,
    }),
  ]);
  assert.equal(afterParentEdit.has("validate"), false);
});

test("requires tool evidence only for side effects", () => {
  const requested = new Set<CodingOperation>(["inspect", "modify"]);
  assert.deepEqual(
    [...codingOperationsRequiringToolEvidence(requested)],
    ["modify"],
  );
  assert.equal(shouldRequireCodingTool("any", requested, new Set()), true);
  assert.equal(
    shouldRequireCodingTool("any", requested, new Set(["modify"])),
    false,
  );
  assert.deepEqual(
    missingRequestedCodingOperations(requested, new Set(["inspect"])),
    ["modify"],
  );
});
