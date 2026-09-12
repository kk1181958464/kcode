import type { AgentActivity, AgentToolName, PermissionPolicy } from "../src/types";
import { permissionCategoriesForCommand } from "../src/permissions";
import { classifyMysqlSql, classifySqlServerSql } from "./sql-policy";
import { failureSummary, isHardFailure } from "./agent-command";
import { redactedToolInput } from "./agent-input";
import type { StructuredToolResult, ToolCall, ToolResult } from "./agent-types";

export const AGENT_TOOL_TITLES: Record<AgentToolName, string> = {
  list_directory: "查看目录",
  glob_files: "查找文件",
  read_many_files: "批量读取",
  path_info: "检查路径",
  read_file: "读取文件",
  search_code: "搜索代码",
  apply_patch: "应用补丁",
  write_file: "修改文件",
  make_directory: "创建目录",
  move_path: "移动文件",
  delete_path: "删除路径",
  git_status: "Git 状态",
  git_remote_status: "校验远端提交",
  git_diff: "Git 差异",
  git_log: "Git 日志",
  git_show: "Git 查看",
  start_process: "启动进程",
  process_output: "进程输出",
  stop_process: "停止进程",
  diagnostics: "项目诊断",
  report_no_change: "确认无需修改",
  request_user_input: "等待补充信息",
  get_context_remaining: "查询上下文余量",
  web_search: "搜索互联网",
  fetch_url: "读取网页",
  credential_list: "查找本地凭据",
  browser_list_credentials: "查找当前网站账号",
  browser_save_credential: "保存当前网站账号",
  credential_save: "保存当前网站账号",
  credential_forget: "删除本地凭据",
  browser_open: "打开浏览器",
  browser_snapshot: "查看网页",
  browser_click: "点击网页",
  browser_type: "填写网页",
  browser_fill_credential: "填写已保存账号",
  browser_screenshot: "网页截图",
  browser_record_start: "开始网页录制",
  browser_record_stop: "停止网页录制",
  ssh_connect: "连接 SSH",
  ssh_set_workspace: "打开远程工作区",
  ssh_run: "运行远程命令",
  ssh_list_directory: "查看远程目录",
  ssh_read_file: "读取远程文件",
  ssh_write_file: "修改远程文件",
  ssh_upload_file: "上传文件到远程",
  ssh_download_file: "从远程下载文件",
  ssh_disconnect: "断开 SSH",
  mysql_connect: "连接 MySQL",
  mysql_connect_via_ssh: "通过 SSH 连接 MySQL",
  mysql_query: "执行 SQL",
  mysql_disconnect: "断开 MySQL",
  sqlserver_connect: "连接 SQL Server",
  sqlserver_connect_via_ssh: "通过 SSH 连接 SQL Server",
  sqlserver_query: "执行 T-SQL",
  sqlserver_disconnect: "断开 SQL Server",
  mongodb_connect: "连接 MongoDB",
  mongodb_connect_via_ssh: "通过 SSH 连接 MongoDB",
  mongodb_execute: "执行 MongoDB 操作",
  mongodb_disconnect: "断开 MongoDB",
  spawn_agent: "创建子 Agent",
  list_agents: "查看子 Agent",
  message_agent: "追加子 Agent 指令",
  wait_agent: "等待子 Agent",
  stop_agent: "停止子 Agent",
  update_plan: "更新执行计划",
  mcp_list_tools: "读取 MCP 工具",
  mcp_call_tool: "调用 MCP 工具",
  run_command: "运行命令",
};

const MONGO_READ_OPERATIONS = new Set([
  "find",
  "aggregate",
  "countDocuments",
  "distinct",
]);

const COMMAND_PERMISSION_TOOLS = new Set<AgentToolName>([
  "run_command",
  "ssh_run",
  "start_process",
]);

const WORKSPACE_WRITE_TOOLS = new Set<AgentToolName>([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
]);

export type ActivityCallOptions = {
  plannerCoordinator?: boolean;
  executorDisplayName?: string;
};

export type ToolActivityOutcome = {
  status: "failed" | "completed" | "success";
  errorSummary?: string;
  cancelled: boolean;
  hardFailure: boolean;
  nonZero: boolean;
};

export type ToolActivityCatchFailure = {
  output: string;
  failureOutput: string;
  errorSummary: string;
  cancelled: boolean;
};

export type ProgressOutputDelta = {
  mode: "append" | "replace";
  value: string;
};

export type ResultEvidence = Pick<
  ToolResult,
  | "changed"
  | "executed"
  | "mutationAttempted"
  | "noChangeReported"
  | "userInputRequested"
  | "operationEvidence"
  | "browserOperationEvidence"
>;

export function activityTitleForCall(
  call: ToolCall,
  options: ActivityCallOptions = {},
) {
  if (call.name === "spawn_agent" && options.plannerCoordinator)
    return `启动执行模型 · ${options.executorDisplayName}`;
  return AGENT_TOOL_TITLES[call.name];
}

export function activityInputForCall(
  call: ToolCall,
  options: ActivityCallOptions = {},
) {
  if (call.name === "spawn_agent")
    return {
      name: String(call.input.name || ""),
      task: String(call.input.task || ""),
      role: String(call.input.role || ""),
      model: options.plannerCoordinator
        ? options.executorDisplayName
        : undefined,
    };
  if (call.name === "message_agent")
    return {
      agentId: String(call.input.agentId || ""),
      message: String(call.input.message || ""),
    };
  return redactedToolInput(call);
}

export function activityPathForCall(call: ToolCall) {
  return typeof call.input.path === "string"
    ? call.input.path
    : typeof call.input.to === "string"
      ? call.input.to
      : undefined;
}

export function activityCommandForCall(call: ToolCall) {
  return typeof call.input.command === "string"
    ? call.input.command
    : undefined;
}

export function permissionCategoriesForToolCall(
  call: ToolCall,
): (keyof PermissionPolicy)[] {
  const mysqlSql =
    call.name === "mysql_query" ? String(call.input.sql || "").trim() : "";
  const mysqlRisk = mysqlSql ? classifyMysqlSql(mysqlSql) : undefined;
  const sqlServerSql =
    call.name === "sqlserver_query"
      ? String(call.input.sql || "").trim()
      : "";
  const sqlServerRisk = sqlServerSql
    ? classifySqlServerSql(sqlServerSql)
    : undefined;
  const mongoOperation =
    call.name === "mongodb_execute"
      ? String(call.input.operation || "")
      : "";
  const databaseRead =
    (call.name === "mysql_query" && mysqlRisk === "read") ||
    (call.name === "sqlserver_query" && sqlServerRisk === "read") ||
    (call.name === "mongodb_execute" &&
      MONGO_READ_OPERATIONS.has(mongoOperation));
  const databaseDelete =
    (call.name === "mysql_query" && mysqlRisk === "destructive") ||
    (call.name === "sqlserver_query" && sqlServerRisk === "destructive") ||
    (call.name === "mongodb_execute" && mongoOperation.startsWith("delete"));
  const databaseTool = /^(mysql|sqlserver|mongodb)_/.test(call.name);
  const databaseConnectionTool =
    databaseTool &&
    (call.name.endsWith("connect") ||
      call.name.includes("connect_via_ssh") ||
      call.name.endsWith("disconnect"));
  const baseCategory: keyof PermissionPolicy | undefined =
    call.name === "credential_save" || call.name === "browser_save_credential"
      ? "workspaceWrite"
      : call.name === "credential_forget"
        ? "deletePaths"
        : call.name === "web_search" ||
            call.name === "fetch_url" ||
            call.name === "mcp_list_tools" ||
            call.name === "mcp_call_tool" ||
            call.name === "git_remote_status" ||
            call.name.startsWith("browser_") ||
            call.name === "ssh_connect" ||
            call.name === "ssh_set_workspace" ||
            call.name === "ssh_list_directory" ||
            call.name === "ssh_read_file" ||
            call.name === "ssh_disconnect" ||
            databaseConnectionTool ||
            databaseRead
          ? "network"
          : databaseDelete
            ? "deletePaths"
            : databaseTool
              ? "workspaceWrite"
              : call.name === "ssh_write_file" ||
                  call.name === "ssh_upload_file" ||
                  call.name === "ssh_download_file"
                ? "workspaceWrite"
                : call.name === "delete_path"
                  ? "deletePaths"
                  : call.name === "stop_process"
                    ? "longRunningProcesses"
                    : WORKSPACE_WRITE_TOOLS.has(call.name)
                      ? "workspaceWrite"
                      : undefined;
  const commandCategories = COMMAND_PERMISSION_TOOLS.has(call.name)
    ? permissionCategoriesForCommand(String(call.input.command ?? ""))
    : [];
  if (call.name === "start_process")
    commandCategories.push("longRunningProcesses");
  return baseCategory ? [baseCategory] : commandCategories;
}

export function approvalCommandForToolCall(call: ToolCall) {
  if (
    call.name === "run_command" ||
    call.name === "ssh_run" ||
    call.name === "start_process"
  )
    return String(call.input.command ?? "");
  return "";
}

export function mutationSnapshotPaths(call: ToolCall) {
  const input = call.input;
  const paths: string[] = [];
  if (call.name === "write_file" && typeof input.file_path === "string")
    paths.push(input.file_path);
  if (call.name === "delete_path" && typeof input.path === "string")
    paths.push(input.path);
  if (call.name === "move_path" && typeof input.source === "string")
    paths.push(input.source);
  if (call.name === "apply_patch" && typeof input.patch === "string") {
    const patchPaths = input.patch.match(
      /\*\*\* (?:Update|Delete|Add) File: (.+)/g,
    );
    if (patchPaths) {
      for (const line of patchPaths) {
        const match = line.match(/\*\*\* (?:Update|Delete) File: (.+)/);
        if (match) paths.push(match[1].trim());
      }
    }
  }
  return paths;
}

export function toolActivityOutcome(
  call: ToolCall,
  result: Pick<ToolResult, "output" | "exitCode" | "executed">,
  aborted: boolean,
): ToolActivityOutcome {
  const cancelled =
    aborted || /命令已取消|操作已取消|任务已取消/i.test(result.output || "");
  const nonZero = result.exitCode !== undefined && result.exitCode !== 0;
  const hardFailure =
    cancelled || (nonZero && isHardFailure(call, result.output || ""));
  return {
    status: hardFailure
      ? "failed"
      : nonZero || result.executed === false
        ? "completed"
        : "success",
    errorSummary: cancelled
      ? "操作已停止"
      : hardFailure
        ? failureSummary(call, result.output || "", result.exitCode)
        : undefined,
    cancelled,
    hardFailure,
    nonZero,
  };
}

export function toolActivityCatchFailure(
  call: ToolCall,
  error: unknown,
  previousOutput: string | undefined,
  aborted: boolean,
): ToolActivityCatchFailure {
  const failureOutput =
    error instanceof Error ? error.message : String(error);
  const cancelled =
    aborted ||
    /任务已取消|命令已取消|已取消|aborted|AbortError/i.test(failureOutput);
  return {
    output: previousOutput
      ? `${previousOutput}\n\n${failureOutput}`
      : failureOutput || (cancelled ? "操作已停止" : "工具执行失败"),
    failureOutput,
    errorSummary: cancelled
      ? "操作已停止"
      : failureSummary(call, failureOutput),
    cancelled,
  };
}

export function progressOutputDelta(
  previous: string,
  next: string,
): ProgressOutputDelta | undefined {
  if (next === previous) return undefined;
  if (next.startsWith(previous))
    return { mode: "append", value: next.slice(previous.length) };
  return { mode: "replace", value: next };
}

export function verificationLiveStatus(output: string) {
  const status = /^\[等待人工验证\]\s*([^。]+)/.exec(output)?.[1];
  return status ? `等待人工验证：${status}` : undefined;
}

export function contextRemainingResult(
  contextWindow: number,
  usedTokens: number,
) {
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const usedPercent =
    contextWindow > 0 ? Math.round((usedTokens / contextWindow) * 100) : 0;
  const payload = {
    contextWindow,
    usedTokens,
    remainingTokens,
    usedPercent,
  };
  return { payload, output: JSON.stringify(payload) };
}

export function pickResultEvidence(result: ToolResult): ResultEvidence {
  return {
    changed: result.changed,
    executed: result.executed,
    mutationAttempted: result.mutationAttempted,
    noChangeReported: result.noChangeReported,
    userInputRequested: result.userInputRequested,
    operationEvidence: result.operationEvidence,
    browserOperationEvidence: result.browserOperationEvidence,
  };
}

export function buildStructuredToolResult(input: {
  activity: Pick<
    AgentActivity,
    | "status"
    | "title"
    | "errorSummary"
    | "output"
    | "diff"
    | "path"
    | "command"
    | "exitCode"
    | "additions"
    | "deletions"
    | "fileChanges"
  >;
  resultEvidence: ResultEvidence;
  effectiveOutput: string;
}): StructuredToolResult {
  const { activity, resultEvidence, effectiveOutput } = input;
  return {
    success: activity.status === "success",
    summary:
      activity.errorSummary ??
      (activity.status === "completed"
        ? resultEvidence.executed === false
          ? `${activity.title}未执行`
          : `${activity.title}已执行完成，退出码 ${activity.exitCode ?? "未知"}`
        : `${activity.title}${activity.status === "success" ? "完成" : "未完成"}`),
    data: {
      output: effectiveOutput,
      diff: activity.diff,
      path: activity.path,
      command: activity.command,
      exitCode: activity.exitCode,
      additions: activity.additions,
      deletions: activity.deletions,
      fileChanges: activity.fileChanges,
      changed: resultEvidence.changed,
      executed: resultEvidence.executed,
      mutationAttempted: resultEvidence.mutationAttempted,
      noChangeReported: resultEvidence.noChangeReported,
      userInputRequested: resultEvidence.userInputRequested,
      operationEvidence: resultEvidence.operationEvidence,
      browserOperationEvidence: resultEvidence.browserOperationEvidence,
    },
    truncated: Boolean(activity.output && activity.output.length >= 100_000),
    error:
      activity.status === "failed"
        ? {
            message:
              activity.errorSummary ?? activity.output ?? "工具执行失败",
            exitCode: activity.exitCode,
          }
        : undefined,
  };
}

export function activityFingerprint(
  call: ToolCall,
  activity: Pick<AgentActivity, "status" | "output" | "diff">,
) {
  return JSON.stringify({
    tool: call.name,
    input: call.input,
    status: activity.status,
    output: activity.output?.slice(-2_000),
    diff: activity.diff?.slice(-2_000),
  });
}

export function isWaitingOnExternalProcessOutput(
  call: ToolCall,
  activity: Pick<AgentActivity, "status" | "exitCode">,
) {
  return (
    call.name === "process_output" &&
    activity.status === "success" &&
    activity.exitCode === undefined
  );
}
