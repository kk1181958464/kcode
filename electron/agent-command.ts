import {
  runSpawnedCommand,
} from "./process-command";
import { conciseFailureOutput } from "./activity-errors";
import { isNotGitRepositoryOutput } from "./git-operation-verification";
import { bundledRipgrepPath } from "./workspace-search";
import { type AgentToolName } from "../src/types";
import type { ToolCall } from "./agent-types";
import path from "node:path";

let ripgrepDir: string | undefined;

function commandEnv(): NodeJS.ProcessEnv {
  if (ripgrepDir === undefined) {
    const rg = bundledRipgrepPath();
    ripgrepDir = rg === "rg" ? "" : path.dirname(rg);
  }
  if (!ripgrepDir) return process.env;
  const key =
    Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ??
    "PATH";
  const current = process.env[key] ?? "";
  return {
    ...process.env,
    [key]: current ? `${ripgrepDir}${path.delimiter}${current}` : ripgrepDir,
  };
}

export function command(
  root: string,
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30_000,
  onOutput?: (output: string) => void,
  idleTimeoutMs?: number,
) {
  return runSpawnedCommand({
    executable,
    args,
    cwd: root,
    env: commandEnv(),
    signal,
    timeoutMs: timeout,
    idleTimeoutMs,
    onOutput,
  }).then(({ output, exitCode }) => ({ output, exitCode }));
}

const FILE_TOOL_FAILURE_LABELS: Partial<Record<AgentToolName, string>> = {
  apply_patch: "补丁应用",
  write_file: "文件写入",
  delete_path: "路径删除",
  move_path: "路径移动",
  make_directory: "目录创建",
  read_file: "文件读取",
  search_code: "代码搜索",
  list_directory: "目录读取",
  path_info: "路径检查",
};

export function failureSummary(
  call: ToolCall,
  output: string,
  exitCode?: number,
) {
  if (
    call.name.startsWith("mysql_") ||
    call.name.startsWith("sqlserver_") ||
    call.name.startsWith("mongodb_")
  )
    return output;
  if (call.name.startsWith("ssh_")) {
    if (call.name === "ssh_run" && exitCode !== undefined) {
      const detail = conciseFailureOutput(output);
      return `远程命令执行失败，退出码 ${exitCode}${detail ? `：${detail}` : "。"}`;
    }
    return output;
  }
  if (call.name.startsWith("git_")) {
    const detail = conciseFailureOutput(output);
    return detail ? `Git 操作失败：${detail}` : "Git 操作失败。";
  }
  if (
    (call.name === "fetch_url" || call.name === "web_search") &&
    /网页读取超时|任务已取消|网页请求失败|GitHub/.test(output)
  )
    return output;
  if (call.name === "run_command") {
    const script = String(call.input.command || "");
    if (/\*\*\* Begin Patch|\bapply_patch\b/i.test(script))
      return "补丁内容被当作 PowerShell 命令执行。请直接使用“应用补丁”工具。";
    if (
      /not recognized|CommandNotFoundException|找不到|无法将.*识别为/i.test(
        output,
      )
    )
      return "命令或程序不存在，请检查名称以及是否已安装。";
    const detail = conciseFailureOutput(output);
    return `命令执行失败，退出码 ${exitCode ?? "未知"}${detail ? `：${detail}` : "。"}`;
  }
  return `${FILE_TOOL_FAILURE_LABELS[call.name] || "工具执行"}失败。`;
}

export function isHardFailure(call: ToolCall, output: string) {
  if (call.name === "ssh_run") {
    const script = String(call.input.command || "");
    return !(
      /\b(?:git|gh)\b/i.test(script) && isNotGitRepositoryOutput(output)
    );
  }
  if (call.name !== "run_command") return true;
  const script = String(call.input.command || "");
  if (/\*\*\* Begin Patch|\bapply_patch\b/i.test(script)) return true;
  if (/命令执行超时|命令已取消|没有新输出，已判定卡住/.test(output))
    return true;
  if (
    /not recognized|CommandNotFoundException|找不到|无法将.*识别为/i.test(
      output,
    )
  )
    return true;
  return false;
}

export function mutationPaths(call: ToolCall) {
  if (call.name === "apply_patch")
    return [
      ...String(call.input.patch || "").matchAll(
        /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm,
      ),
    ].map((match) => match[1]);
  if (call.name === "move_path")
    return [String(call.input.from || ""), String(call.input.to || "")].filter(
      Boolean,
    );
  if (
    call.name === "write_file" ||
    call.name === "make_directory" ||
    call.name === "delete_path"
  )
    return [String(call.input.path || "")].filter(Boolean);
  return [];
}
