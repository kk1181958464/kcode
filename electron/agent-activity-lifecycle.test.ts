import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolName } from "../src/types";
import type { ToolCall } from "./agent-types";
import {
  AGENT_TOOL_TITLES,
  activityCommandForCall,
  activityFingerprint,
  activityInputForCall,
  activityPathForCall,
  activityTitleForCall,
  approvalCommandForToolCall,
  buildStructuredToolResult,
  contextRemainingResult,
  isWaitingOnExternalProcessOutput,
  mutationSnapshotPaths,
  permissionCategoriesForToolCall,
  pickResultEvidence,
  progressOutputDelta,
  toolActivityCatchFailure,
  toolActivityOutcome,
  verificationLiveStatus,
} from "./agent-activity-lifecycle";

const call = (
  name: AgentToolName,
  input: Record<string, unknown> = {},
): ToolCall => ({
  id: "call-1",
  name,
  input,
});

test("activity titles cover every advertised tool and specialize planner spawn", () => {
  assert.equal(AGENT_TOOL_TITLES.read_file, "读取文件");
  assert.equal(AGENT_TOOL_TITLES.run_command, "运行命令");
  assert.equal(activityTitleForCall(call("spawn_agent")), "创建子 Agent");
  assert.equal(
    activityTitleForCall(call("spawn_agent"), {
      plannerCoordinator: true,
      executorDisplayName: "GPT Executor",
    }),
    "启动执行模型 · GPT Executor",
  );
});

test("activity input redacts secrets and specializes spawn/message payloads", () => {
  assert.deepEqual(
    activityInputForCall(
      call("spawn_agent", {
        name: "fixer",
        task: "fix login",
        role: "executor",
        extra: "drop",
      }),
      { plannerCoordinator: true, executorDisplayName: "GPT Executor" },
    ),
    {
      name: "fixer",
      task: "fix login",
      role: "executor",
      model: "GPT Executor",
    },
  );
  assert.deepEqual(
    activityInputForCall(
      call("message_agent", { agentId: "child-1", message: "continue", extra: 1 }),
    ),
    { agentId: "child-1", message: "continue" },
  );
  assert.equal(
    activityInputForCall(
      call("credential_save", { password: "secret", origin: "https://app" }),
    ).password,
    "[已安全隐藏]",
  );
  assert.equal(activityPathForCall(call("delete_path", { path: "a.ts" })), "a.ts");
  assert.equal(activityPathForCall(call("move_path", { to: "b.ts" })), "b.ts");
  assert.equal(
    activityCommandForCall(call("run_command", { command: "npm test" })),
    "npm test",
  );
});

test("permission categories follow tool family, SQL risk and command policy", () => {
  assert.deepEqual(permissionCategoriesForToolCall(call("read_file")), []);
  assert.deepEqual(
    permissionCategoriesForToolCall(call("credential_save")),
    ["workspaceWrite"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("credential_forget")),
    ["deletePaths"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("web_search")),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("browser_click")),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("ssh_connect")),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("ssh_write_file")),
    ["workspaceWrite"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("delete_path")),
    ["deletePaths"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("stop_process")),
    ["longRunningProcesses"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("apply_patch")),
    ["workspaceWrite"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mysql_query", { sql: "SELECT * FROM users" }),
    ),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mysql_query", { sql: "DELETE FROM users WHERE id = 1" }),
    ),
    ["deletePaths"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mysql_query", { sql: "INSERT INTO users(id) VALUES (1)" }),
    ),
    ["workspaceWrite"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(call("mysql_connect_via_ssh")),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mongodb_execute", { operation: "find" }),
    ),
    ["network"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mongodb_execute", { operation: "deleteMany" }),
    ),
    ["deletePaths"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("mongodb_execute", { operation: "insertOne" }),
    ),
    ["workspaceWrite"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("run_command", { command: "git push origin main" }),
    ),
    ["gitPublish", "runCommands"],
  );
  assert.deepEqual(
    permissionCategoriesForToolCall(
      call("start_process", { command: "npm start" }),
    ),
    ["runCommands", "longRunningProcesses"],
  );
});

test("approval cache command is only taken from shell-like tools", () => {
  assert.equal(
    approvalCommandForToolCall(call("run_command", { command: "npm test" })),
    "npm test",
  );
  assert.equal(
    approvalCommandForToolCall(call("ssh_run", { command: "ls" })),
    "ls",
  );
  assert.equal(
    approvalCommandForToolCall(call("start_process", { command: "npm start" })),
    "npm start",
  );
  assert.equal(approvalCommandForToolCall(call("write_file")), "");
});

test("mutation snapshots use file_path/source and skip Add File lines", () => {
  assert.deepEqual(
    mutationSnapshotPaths(call("write_file", { file_path: "a.ts", path: "ignored.ts" })),
    ["a.ts"],
  );
  assert.deepEqual(
    mutationSnapshotPaths(call("delete_path", { path: "gone.ts" })),
    ["gone.ts"],
  );
  assert.deepEqual(
    mutationSnapshotPaths(
      call("move_path", { source: "from.ts", from: "other.ts", to: "to.ts" }),
    ),
    ["from.ts"],
  );
  assert.deepEqual(
    mutationSnapshotPaths(
      call("apply_patch", {
        patch: [
          "*** Add File: new.ts",
          "*** Update File: changed.ts",
          "*** Delete File: old.ts",
        ].join("\n"),
      }),
    ),
    ["changed.ts", "old.ts"],
  );
  assert.deepEqual(mutationSnapshotPaths(call("read_file", { path: "a.ts" })), []);
});

test("tool activity outcome maps hard failure, non-zero and unexecuted results", () => {
  assert.deepEqual(
    toolActivityOutcome(
      call("read_file"),
      { output: "ok", exitCode: 0 },
      false,
    ),
    {
      status: "success",
      errorSummary: undefined,
      cancelled: false,
      hardFailure: false,
      nonZero: false,
    },
  );
  assert.equal(
    toolActivityOutcome(
      call("run_command", { command: "npm test" }),
      { output: "failed", exitCode: 1 },
      false,
    ).status,
    "completed",
  );
  assert.equal(
    toolActivityOutcome(
      call("diagnostics"),
      { output: "skipped", executed: false },
      false,
    ).status,
    "completed",
  );
  const cancelled = toolActivityOutcome(
    call("run_command"),
    { output: "任务已取消" },
    false,
  );
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.errorSummary, "操作已停止");
  const hard = toolActivityOutcome(
    call("run_command", { command: "missing-bin" }),
    { output: "CommandNotFoundException", exitCode: 1 },
    false,
  );
  assert.equal(hard.status, "failed");
  assert.equal(hard.hardFailure, true);
});

test("catch failure keeps prior output and classifies cancel vs hard error", () => {
  const cancelled = toolActivityCatchFailure(
    call("read_file"),
    new Error("AbortError: aborted"),
    "partial",
    false,
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.errorSummary, "操作已停止");
  assert.equal(cancelled.failureOutput, "AbortError: aborted");
  assert.equal(cancelled.output, "partial\n\nAbortError: aborted");
  const failed = toolActivityCatchFailure(
    call("write_file"),
    new Error("disk full"),
    undefined,
    false,
  );
  assert.equal(failed.cancelled, false);
  assert.equal(failed.errorSummary, "文件写入失败。");
  assert.equal(failed.output, "disk full");
});

test("progress output prefers append when the stream grows in place", () => {
  assert.equal(progressOutputDelta("hello", "hello"), undefined);
  assert.deepEqual(progressOutputDelta("hello", "hello world"), {
    mode: "append",
    value: " world",
  });
  assert.deepEqual(progressOutputDelta("old", "new"), {
    mode: "replace",
    value: "new",
  });
  assert.equal(
    verificationLiveStatus("[等待人工验证] 截图核验。后续继续"),
    "等待人工验证：截图核验",
  );
  assert.equal(verificationLiveStatus("running"), undefined);
});

test("structured result and context remaining keep the runner contract", () => {
  const remaining = contextRemainingResult(1000, 250);
  assert.deepEqual(remaining.payload, {
    contextWindow: 1000,
    usedTokens: 250,
    remainingTokens: 750,
    usedPercent: 25,
  });
  assert.equal(contextRemainingResult(0, 10).payload.usedPercent, 0);
  const evidence = pickResultEvidence({
    output: "done",
    changed: true,
    executed: true,
    operationEvidence: ["modify"],
  });
  const success = buildStructuredToolResult({
    activity: {
      status: "success",
      title: "修改文件",
      output: "ok",
      path: "a.ts",
    },
    resultEvidence: evidence,
    effectiveOutput: "ok",
  });
  assert.equal(success.success, true);
  assert.equal(success.summary, "修改文件完成");
  assert.equal(success.data.changed, true);
  assert.equal(
    buildStructuredToolResult({
      activity: { status: "completed", title: "项目诊断", exitCode: 2 },
      resultEvidence: { executed: true },
      effectiveOutput: "",
    }).summary,
    "项目诊断已执行完成，退出码 2",
  );
  assert.equal(
    buildStructuredToolResult({
      activity: { status: "completed", title: "项目诊断" },
      resultEvidence: { executed: false },
      effectiveOutput: "",
    }).summary,
    "项目诊断未执行",
  );
  const failed = buildStructuredToolResult({
    activity: {
      status: "failed",
      title: "读取文件",
      errorSummary: "文件读取失败。",
      exitCode: 1,
    },
    resultEvidence: {},
    effectiveOutput: "boom",
  });
  assert.equal(failed.success, false);
  assert.deepEqual(failed.error, {
    message: "文件读取失败。",
    exitCode: 1,
  });
});

test("fingerprint and external wait flags stay derived from activity facts", () => {
  const fingerprint = activityFingerprint(call("read_file", { path: "a.ts" }), {
    status: "success",
    output: "x".repeat(2_100),
    diff: "y".repeat(2_100),
  });
  const parsed = JSON.parse(fingerprint) as {
    output: string;
    diff: string;
    tool: string;
  };
  assert.equal(parsed.tool, "read_file");
  assert.equal(parsed.output.length, 2_000);
  assert.equal(parsed.diff.length, 2_000);
  assert.equal(
    isWaitingOnExternalProcessOutput(call("process_output"), {
      status: "success",
    }),
    true,
  );
  assert.equal(
    isWaitingOnExternalProcessOutput(call("process_output"), {
      status: "success",
      exitCode: 0,
    }),
    false,
  );
});
