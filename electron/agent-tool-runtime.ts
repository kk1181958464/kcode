import { command } from "./agent-command";
import { approvalCache } from "./approval-cache";
import { FileReadCache } from "./file-read-cache";
import { backgroundProcessManager } from "./background-process-manager";
import {
  listDirectory,
  readManyFiles,
  pathInfo,
  makeDirectory,
  movePath,
  deletePath,
} from "./file-tools";
import { readFileTool, writeFileTool } from "./file-read-write";
import { applyPatchTool } from "./file-patch";
import { executeGitTool } from "./git-tools";
import { executeProcessTool } from "./process-tools";
import { executeWebTool } from "./web-tools";
import { executeSshTool } from "./ssh-session-tools";
import { executeDatabaseTool } from "./database-tools";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch, diffLines } from "diff";
import { type ModelRequest } from "../src/types";
import { toolRegistry } from "./tool-registry";
import { turnSteeringQueue } from "./turn-steering";
import { cleanupBrowsers } from "./browser";
import { executeBrowserTool } from "./browser-tools";
import { executeCredentialTool } from "./credential-tools";
import { cleanupSshSessions, undoSshActivity } from "./ssh";
import { cleanupMysqlSessions } from "./mysql";
import { cleanupSqlServerSessions } from "./sqlserver";
import { cleanupMongoSessions } from "./mongodb";
import {
  bundledRipgrepPath,
  nativeGlobFiles,
  nativeSearchCode,
} from "./workspace-search";
import { beginSubagentCleanup } from "./subagents";
import { executeControlTool } from "./agent-control-tools";
import type { AgentRunner, ToolCall, ToolResult } from "./agent-types";
import {
  clearEditReview,
  keepPendingFiles,
  listEditCheckpoints,
  recordPendingEdit,
  restoreEditCheckpoint,
  undoPendingFiles,
} from "./edit-review";

export const approvals = new Map<string, (allowed: boolean) => void>();

const undoSnapshots = new Map<
  string,
  {
    root: string;
    requestId: string;
    file: string;
    before: string;
    after: string;
    existed: boolean;
  }
>();

export async function cleanupAgentRecords(
  requestIds: string[],
  activityIds: string[],
) {
  const subagentCleanup = beginSubagentCleanup(requestIds);
  const childRequestIds = subagentCleanup.requestIds;
  const requests = new Set([...requestIds, ...childRequestIds]),
    activities = new Set(activityIds);
  for (const [activityId, snapshot] of undoSnapshots)
    if (activities.has(activityId) || requests.has(snapshot.requestId))
      undoSnapshots.delete(activityId);
  clearEditReview([...requests], [...activities]);
  for (const [key, resolve] of approvals) {
    if ([...requests].some((requestId) => key.startsWith(`${requestId}:`))) {
      resolve(false);
      approvals.delete(key);
    }
  }
  await backgroundProcessManager.cleanup(requests);
  const allRequestIds = [...requests];
  cleanupBrowsers(allRequestIds);
  cleanupMysqlSessions(allRequestIds);
  cleanupSqlServerSessions(allRequestIds);
  cleanupMongoSessions(allRequestIds);
  cleanupSshSessions(allRequestIds, activityIds);
  await subagentCleanup.settle();
}

export async function cleanupAllBackgroundProcesses() {
  await backgroundProcessManager.cleanupAll();
}

export async function stopBackgroundProcessById(id: string) {
  await backgroundProcessManager.stopById(id);
}

export function resolveApproval(
  requestId: string,
  activityId: string,
  allowed: boolean,
) {
  const exactKey = `${requestId}:${activityId}`;
  const exact = approvals.get(exactKey);
  if (exact) {
    exact(allowed);
    approvals.delete(exactKey);
    return;
  }
  for (const [key, resolve] of approvals)
    if (key.endsWith(`:${activityId}`)) {
      resolve(allowed);
      approvals.delete(key);
      return;
    }
}

export function resolveApprovalWithScope(
  requestId: string,
  activityId: string,
  allowed: boolean,
  scope: "once" | "session" | "permanent",
  command?: string,
  category?: string,
  workspace?: string,
) {
  // Cache the approval if scope is session or permanent
  if (allowed && scope !== "once" && command) {
    approvalCache.approve(command, scope, category ?? "runCommands", workspace);
  }
  // Resolve the pending approval
  resolveApproval(requestId, activityId, allowed);
}

export function steerAgent(requestId: string, content: string) {
  turnSteeringQueue.push(requestId, content);
}

export function clearAgentSteering(requestId: string) {
  turnSteeringQueue.clear(requestId);
}

export function clearAgentToolTraces(requestId: string) {
  toolRegistry.clearRequest(requestId);
}

export async function undoActivity(
  workspaceRoot: string,
  activityId: string,
  force = false,
) {
  const snapshot = undoSnapshots.get(activityId);
  if (!snapshot) {
    const remoteResult = await undoSshActivity(activityId, force);
    if (remoteResult) return remoteResult;
  }
  if (!snapshot || path.resolve(workspaceRoot) !== snapshot.root)
    return { success: false, message: "撤销记录已失效或不属于当前工作区" };
  let current = "";
  try {
    current = await readFile(snapshot.file, "utf8");
  } catch {
    return { success: false, message: "文件已被删除，无法安全撤销" };
  }
  if (current !== snapshot.after && !force)
    return {
      success: false,
      conflict: true,
      message: "文件在这个版本之后又被修改过",
    };
  if (snapshot.existed) await writeFile(snapshot.file, snapshot.before, "utf8");
  else await unlink(snapshot.file);
  undoSnapshots.delete(activityId);
  return {
    success: true,
    message: snapshot.existed ? "已恢复修改前内容" : "已删除本次新建的文件",
  };
}

export async function keepFileChanges(
  workspaceRoot: string,
  requestId: string,
  paths?: string[],
) {
  const result = await keepPendingFiles(workspaceRoot, requestId, paths);
  if (result.success) {
    for (const activityId of result.activityIds) undoSnapshots.delete(activityId);
  }
  return result;
}

export async function undoFileChanges(
  workspaceRoot: string,
  requestId: string,
  paths?: string[],
  force = false,
) {
  const result = await undoPendingFiles(
    workspaceRoot,
    requestId,
    paths,
    force,
  );
  if (result.success) {
    for (const activityId of result.activityIds) undoSnapshots.delete(activityId);
  }
  return result;
}

export async function restoreFileCheckpoint(
  checkpointId: string,
  force = false,
) {
  const result = await restoreEditCheckpoint(checkpointId, force);
  if (result.success) {
    for (const activityId of result.activityIds) undoSnapshots.delete(activityId);
  }
  return result;
}

export function listFileCheckpoints(requestId?: string) {
  return listEditCheckpoints(requestId);
}

function workspacePath(root: string, relative: unknown) {
  if (typeof relative !== "string" || !relative.trim())
    throw new Error("缺少文件路径");
  // Relative paths resolve against the workspace root; absolute paths (including
  // other drives) are honored as-is so the agent can reach files outside the
  // current workspace when the user asks for them.
  return path.resolve(root, relative);
}

function diffFor(file: string, before: string, after: string) {
  if (before === after) return { diff: "", additions: 0, deletions: 0 };
  let additions = 0,
    deletions = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split("\n").length - 1;
    if (part.added) additions += count;
    if (part.removed) deletions += count;
  }
  return {
    diff: createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, "", "", {
      context: 3,
    }),
    additions,
    deletions,
  };
}

export async function execute(
  root: string,
  requestId: string,
  browserSessionId: string,
  activityId: string,
  call: ToolCall,
  request: ModelRequest,
  signal: AbortSignal,
  fileReadCache: FileReadCache,
  runChildAgent: AgentRunner,
  onProgress: (output: string) => void = () => undefined,
  waitTimeoutOverrideMs?: number,
): Promise<ToolResult> {
  if (call.name === "list_directory") {
    if (signal.aborted) throw new Error("任务已取消");
    return listDirectory(root, call.input.path, Boolean(call.input.recursive));
  }
  if (call.name === "glob_files") {
    const base = workspacePath(
      root,
      typeof call.input.path === "string" ? call.input.path : ".",
    );
    const pattern = String(call.input.pattern || "");
    if (!pattern) throw new Error("缺少 glob 模式");
    let output = "";
    try {
      const result = await command(
        base,
        bundledRipgrepPath(),
        [
          "--files",
          "--hidden",
          "--glob",
          "!.git",
          "--glob",
          "!node_modules",
          "--glob",
          pattern,
        ],
        signal,
        15_000,
      );
      if (result.exitCode > 1)
        throw new Error(result.output || `文件查找失败 (${result.exitCode})`);
      output = result.output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      output = await nativeGlobFiles(base, pattern, signal);
    }
    return {
      path: path.relative(root, base) || ".",
      output: output || "未找到匹配文件",
    };
  }
  if (call.name === "read_many_files") {
    if (signal.aborted) throw new Error("任务已取消");
    return readManyFiles(root, call.input.paths);
  }
  if (call.name === "path_info") {
    if (signal.aborted) throw new Error("任务已取消");
    return pathInfo(root, call.input.path);
  }
  if (call.name === "read_file") {
    if (signal.aborted) throw new Error("任务已取消");
    return readFileTool(root, call.input, fileReadCache);
  }
  if (call.name === "search_code") {
    const query = String(call.input.query || "");
    if (!query) throw new Error("缺少搜索内容");
    const args = [
      "-n",
      "--hidden",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
      "--max-count",
      "200",
    ];
    if (call.input.glob) args.push("--glob", String(call.input.glob));
    args.push("--", query, ".");
    let output = "";
    try {
      const result = await command(
        root,
        bundledRipgrepPath(),
        args,
        signal,
        15_000,
      );
      if (result.exitCode > 1)
        throw new Error(result.output || `搜索失败 (${result.exitCode})`);
      output = result.output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      output = await nativeSearchCode(
        root,
        query,
        typeof call.input.glob === "string" ? call.input.glob : undefined,
        signal,
      );
    }
    return { output: output || "未找到匹配项" };
  }
  if (call.name === "write_file") {
    if (signal.aborted) throw new Error("任务已取消");
    return writeFileTool(root, call.input, {
      cache: fileReadCache,
      onSnapshot: ({ file, before, after, existed }) => {
        undoSnapshots.set(activityId, {
          root,
          requestId,
          file,
          before,
          after,
          existed,
        });
        recordPendingEdit({
          root,
          requestId,
          activityId,
          file,
          before,
          existed,
        });
      },
      diff: diffFor,
    });
  }
  if (call.name === "apply_patch")
    return applyPatchTool(root, String(call.input.patch || ""), {
      cache: fileReadCache,
      onUndo: (change) =>
        undoSnapshots.set(activityId, { root, requestId, ...change }),
      onPending: (change) =>
        recordPendingEdit({
          root,
          requestId,
          activityId,
          file: change.file,
          before: change.before,
          existed: change.existed,
        }),
      diff: diffFor,
    });
  if (call.name === "make_directory") {
    if (signal.aborted) throw new Error("任务已取消");
    return makeDirectory(root, call.input.path);
  }
  if (call.name === "move_path") {
    if (signal.aborted) throw new Error("任务已取消");
    return movePath(root, call.input.from, call.input.to);
  }
  if (call.name === "delete_path") {
    if (signal.aborted) throw new Error("任务已取消");
    return deletePath(root, call.input.path, Boolean(call.input.recursive));
  }
  if (call.name === "git_status") {
    return executeGitTool(root, call.name, call.input, signal, command);
  }
  if (call.name === "git_remote_status") {
    return executeGitTool(root, call.name, call.input, signal, command);
  }
  if (call.name === "git_diff") {
    return executeGitTool(root, call.name, call.input, signal, command);
  }
  if (call.name === "git_log") {
    return executeGitTool(root, call.name, call.input, signal, command);
  }
  if (call.name === "git_show") {
    return executeGitTool(root, call.name, call.input, signal, command);
  }
  if (
    call.name === "start_process" ||
    call.name === "process_output" ||
    call.name === "stop_process"
  )
    return executeProcessTool(root, requestId, call.name, call.input);
  if (call.name === "web_search" || call.name === "fetch_url")
    return executeWebTool(call.name, call.input, signal);
  if (
    call.name === "credential_list" ||
    call.name === "browser_list_credentials" ||
    call.name === "browser_save_credential" ||
    call.name === "credential_save" ||
    call.name === "credential_forget"
  )
    return executeCredentialTool(
      call.name,
      call.input,
      browserSessionId,
    );
  if (
    call.name === "browser_open" ||
    call.name === "browser_snapshot" ||
    call.name === "browser_click" ||
    call.name === "browser_type" ||
    call.name === "browser_fill_credential" ||
    call.name === "browser_screenshot" ||
    call.name === "browser_record_start" ||
    call.name === "browser_record_stop"
  )
    return executeBrowserTool(
      call.name,
      call.input,
      browserSessionId,
      requestId,
      request.messages,
      signal,
      onProgress,
    );
  if (call.name.startsWith("ssh_"))
    return executeSshTool({
      root,
      browserSessionId,
      requestId,
      activityId,
      name: call.name,
      input: call.input,
      messages: request.messages,
      remoteWorkspace: request.remoteWorkspace,
      signal,
      onProgress,
      diffFor,
    });
  if (
    call.name.startsWith("mysql_") ||
    call.name.startsWith("sqlserver_") ||
    call.name.startsWith("mongodb_")
  )
    return executeDatabaseTool({
      browserSessionId,
      requestId,
      activityId,
      name: call.name,
      input: call.input,
      remoteWorkspaceRoot: request.remoteWorkspace?.rootPath,
      signal,
    });
  return executeControlTool({
    root,
    requestId,
    name: call.name,
    input: call.input,
    request,
    signal,
    runChildAgent,
    onProgress,
    waitTimeoutOverrideMs,
  });
}
