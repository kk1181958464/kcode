import {
  defaultCommandIdleTimeoutMs,
  defaultCommandTimeoutMs,
} from "./process-command";
import { command } from "./agent-command";
import { localShellInvocation } from "./local-shell";
import {
  isInspectionCommand,
  isValidationCommand,
  type CodingOperation,
} from "./coding-operation-verification";
import { callMcpTool, listMcpTools } from "./mcp";
import {
  resolveProjectDiagnostic,
  type DiagnosticKind,
} from "./project-diagnostics";
import {
  effectiveCommandExitCode,
  windowsCommandIssue,
} from "./command-guidance";
import { normalizePlanUpdate } from "../src/execution-plan";
import { normalizePendingUserInput } from "./agent-input";
import {
  executeSubagentTool,
  SUBAGENT_TOOL_NAMES,
  type SubagentToolContext,
  type SubagentToolDeps,
} from "./subagent-tools";
import type { ToolResult } from "./agent-types";

export type ControlToolContext = SubagentToolContext;

export type CommandToolDeps = {
  platform: NodeJS.Platform;
  listMcpTools: typeof listMcpTools;
  callMcpTool: typeof callMcpTool;
  resolveProjectDiagnostic: typeof resolveProjectDiagnostic;
  command: typeof command;
};

export type ControlToolDeps = {
  subagent?: SubagentToolDeps;
  command?: CommandToolDeps;
};

const defaultCommandDeps: CommandToolDeps = {
  platform: process.platform,
  listMcpTools,
  callMcpTool,
  resolveProjectDiagnostic,
  command,
};

export async function executeControlTool(
  ctx: ControlToolContext,
  deps: ControlToolDeps = {},
): Promise<ToolResult> {
  if (SUBAGENT_TOOL_NAMES.has(ctx.name))
    return executeSubagentTool(ctx, deps.subagent);

  const resolved = deps.command ?? defaultCommandDeps;
  const { root, name, input, signal } = ctx;
  const onProgress = ctx.onProgress ?? (() => undefined);

  if (name === "update_plan") {
    const planUpdate = normalizePlanUpdate({
      explanation: input.explanation,
      plan: input.plan,
    });
    return {
      output: planUpdate.explanation
        ? `计划已更新：${planUpdate.explanation}`
        : "计划已更新",
      planUpdate,
    };
  }
  if (name === "report_no_change") {
    const reason = String(input.reason || "")
      .replace(/\s+/g, " ")
      .trim();
    if (reason.length < 8)
      throw new Error("无需修改的原因必须包含具体检查结论");
    return {
      output: `无需修改：${reason}`,
      changed: false,
      noChangeReported: true,
    };
  }
  if (name === "request_user_input") {
    const pendingInput = normalizePendingUserInput(input);
    if (!pendingInput)
      throw new Error("等待用户输入时必须说明问题并列出所需信息");
    return {
      output: `等待补充信息：${pendingInput.question}\n需要：${pendingInput.fields.join("、")}`,
      changed: false,
      userInputRequested: true,
    };
  }
  if (name === "mcp_list_tools") {
    const server = String(input.server || "").trim();
    if (!server) throw new Error("缺少 MCP 服务名称");
    const tools = await resolved.listMcpTools(server, signal);
    return {
      output: JSON.stringify(
        {
          server,
          tools,
          hint: "下一步使用 mcp_call_tool，并把工具名和 arguments 按 schema 传入。",
        },
        null,
        2,
      ),
      executed: true,
    };
  }
  if (name === "mcp_call_tool") {
    const server = String(input.server || "").trim();
    const tool = String(input.tool || "").trim();
    if (!server || !tool) throw new Error("MCP 调用缺少 server 或 tool");
    const result = await resolved.callMcpTool(
      server,
      tool,
      input.arguments && typeof input.arguments === "object"
        ? (input.arguments as Record<string, unknown>)
        : {},
      signal,
      onProgress,
    );
    return {
      output: result.isError
        ? `MCP 工具返回错误：${result.output}`
        : result.output,
      executed: true,
      operationEvidence: result.isError ? [] : ["execute"],
    };
  }
  if (name === "diagnostics") {
    const kind = String(input.kind || "");
    if (!new Set(["typecheck", "test", "lint", "build"]).has(kind))
      throw new Error("不支持的诊断类型");
    const diagnostic = await resolved.resolveProjectDiagnostic(
      root,
      kind as DiagnosticKind,
    );
    if (!diagnostic.script)
      return {
        command: "未执行",
        output: diagnostic.message ?? "项目未配置对应诊断脚本，已跳过。",
        executed: false,
      };
    const shell = localShellInvocation(diagnostic.command!, resolved.platform);
    const result = await resolved.command(
      root,
      shell.executable,
      shell.args,
      signal,
      defaultCommandTimeoutMs(diagnostic.command!),
    );
    return {
      command: diagnostic.command,
      output: result.output || "诊断未产生输出",
      exitCode: result.exitCode,
      executed: true,
      operationEvidence:
        result.exitCode === 0 ? ["execute", "validate"] : ["execute"],
    };
  }
  const script = String(input.command || "");
  if (!script) throw new Error("缺少命令");
  if (resolved.platform === "win32") {
    const commandIssue = windowsCommandIssue(script);
    if (commandIssue)
      return {
        output: commandIssue,
        command: script,
        executed: false,
      };
  }
  const timeoutMs = Math.min(
    600_000,
    Math.max(
      1_000,
      Number(input.timeoutMs) || defaultCommandTimeoutMs(script),
    ),
  );
  // Network CLIs often print nothing until they finish or hang. Package
  // installation gets a wider silence window; other network commands retain
  // the tighter guard so the UI cannot remain stuck for the full timeout.
  const idleTimeoutMs = defaultCommandIdleTimeoutMs(script, timeoutMs);
  const shell = localShellInvocation(script, resolved.platform);
  const result = await resolved.command(
    root,
    shell.executable,
    shell.args,
    signal,
    timeoutMs,
    onProgress,
    idleTimeoutMs,
  );
  const exitCode = effectiveCommandExitCode(result.exitCode, result.output);
  const operationEvidence: CodingOperation[] = ["execute"];
  const purpose = String(input.purpose || "");
  if (exitCode === 0 && purpose === "modify") operationEvidence.push("modify");
  if (
    (exitCode === 0 || exitCode === 1) &&
    purpose !== "modify" &&
    (purpose === "inspect" || isInspectionCommand(script))
  )
    operationEvidence.push("inspect");
  if (
    exitCode === 0 &&
    purpose !== "modify" &&
    (purpose === "validate" || isValidationCommand(script))
  )
    operationEvidence.push("validate");
  return {
    output: result.output || "命令未产生输出",
    command: script,
    exitCode,
    executed: true,
    mutationAttempted: purpose === "modify",
    operationEvidence,
  };
}
