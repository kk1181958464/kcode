import { createRequire } from "node:module";
import { defaultCommandTimeoutMs } from "./process-command";
import {
  isInspectionCommand,
  isValidationCommand,
  type CodingOperation,
} from "./coding-operation-verification";
import { publicSshCredentialReference } from "./credential-tools";
import { sshWorkspaceCommand } from "./ssh-remote-path";
import type { ToolResult } from "./agent-types";
import type { SshFileOperationContext } from "./ssh-tool-operations";
import type { ModelRequest } from "../src/types";

const requireProduction = createRequire(__filename);

export type SshConnectResult = {
  connected: boolean;
  host: string;
  port: number;
  username: string;
  hostFingerprint?: string;
};

export type SshRemoteProfileInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  rootPath: string;
  remembered: boolean;
};

export type SshRemoteStateInfo = {
  connected: boolean;
  profile?: SshRemoteProfileInfo;
};

export type SshToolDeps = {
  savedSshCredential: (selector: string) => Promise<SshRemoteProfileInfo>;
  connectSavedSshRemote: (
    taskId: string,
    profileId: string,
    rootPath?: string,
  ) => Promise<SshRemoteStateInfo>;
  sshRemoteState: (taskId: string) => Promise<SshRemoteStateInfo>;
  privateKeyForSshTool: (
    input: Record<string, unknown>,
    messages: ModelRequest["messages"],
  ) => Promise<string | undefined>;
  connectSsh: (
    sessionId: string,
    requestId: string,
    input: {
      host: string;
      port: number;
      username: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      rememberForRemoteWorkspace: boolean;
    },
    signal: AbortSignal,
  ) => Promise<SshConnectResult>;
  resolveSshRoot: (
    sessionId: string,
    requestId: string,
    requestedPath: string,
    signal: AbortSignal,
  ) => Promise<string>;
  adoptActiveSshRemote: (
    taskId: string,
    requestedRootPath?: string,
    preferredName?: string,
  ) => Promise<SshRemoteStateInfo>;
  runSshCommand: (
    sessionId: string,
    requestId: string,
    command: string,
    signal: AbortSignal,
    options: {
      stdin?: string;
      pty?: boolean;
      timeoutMs?: number;
      onOutput?: (output: string) => void;
    },
  ) => Promise<{ output: string; exitCode: number }>;
  disconnectSsh: (sessionId: string) => boolean;
  executeSshFileOperation: (
    ctx: SshFileOperationContext,
  ) => Promise<ToolResult | undefined>;
};

export type SshToolContext = {
  root: string;
  browserSessionId: string;
  requestId: string;
  activityId: string;
  name: string;
  input: Record<string, unknown>;
  messages: ModelRequest["messages"];
  remoteWorkspace?: { rootPath: string };
  signal: AbortSignal;
  onProgress?: (output: string) => void;
  diffFor: (
    file: string,
    before: string,
    after: string,
  ) => { diff: string; additions: number; deletions: number };
};

const SSH_FILE_TOOLS = new Set([
  "ssh_list_directory",
  "ssh_read_file",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_download_file",
]);

function productionSshDeps(): SshToolDeps {
  const ssh = requireProduction("./ssh") as typeof import("./ssh");
  const remote = requireProduction("./ssh-remote") as typeof import("./ssh-remote");
  const cred = requireProduction("./credential-tools") as typeof import("./credential-tools");
  const key = requireProduction("./ssh-tool-input") as typeof import("./ssh-tool-input");
  const files = requireProduction("./ssh-tool-operations") as typeof import("./ssh-tool-operations");
  return {
    savedSshCredential: cred.savedSshCredential,
    connectSavedSshRemote: remote.connectSavedSshRemote,
    sshRemoteState: remote.sshRemoteState,
    privateKeyForSshTool: key.privateKeyForSshTool,
    connectSsh: ssh.connectSsh,
    resolveSshRoot: ssh.resolveSshRoot,
    adoptActiveSshRemote: remote.adoptActiveSshRemote,
    runSshCommand: ssh.runSshCommand,
    disconnectSsh: ssh.disconnectSsh,
    executeSshFileOperation: files.executeSshFileOperation,
  };
}

export async function executeSshTool(
  ctx: SshToolContext,
  deps?: SshToolDeps,
): Promise<ToolResult> {
  const resolved = deps ?? productionSshDeps();
  const {
    root,
    browserSessionId,
    requestId,
    activityId,
    name,
    input,
    messages,
    signal,
  } = ctx;
  const onProgress = ctx.onProgress ?? (() => undefined);
  const runtimeRemoteState = await resolved
    .sshRemoteState(browserSessionId)
    .catch(() => undefined);
  const activeRemoteWorkspace =
    (runtimeRemoteState?.connected ? runtimeRemoteState.profile : undefined) ??
    ctx.remoteWorkspace;

  if (name === "ssh_connect") {
    const credentialName = String(input.credentialName || "").trim();
    if (credentialName) {
      const saved = await resolved.savedSshCredential(credentialName);
      const requestedRootPath = String(input.rootPath || "").trim();
      const state = await resolved.connectSavedSshRemote(
        browserSessionId,
        saved.id,
        requestedRootPath || ctx.remoteWorkspace?.rootPath || undefined,
      );
      const profile = state.profile;
      if (!profile) throw new Error(`SSH 凭据“${saved.name}”连接后状态丢失。`);
      return {
        output: JSON.stringify(
          {
            connected: state.connected,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            rootPath: profile.rootPath,
            credential: publicSshCredentialReference(profile),
          },
          null,
          2,
        ),
        path: profile.rootPath,
      };
    }
    const privateKey = await resolved.privateKeyForSshTool(input, messages);
    const result = await resolved.connectSsh(
      browserSessionId,
      requestId,
      {
        host: String(input.host || ""),
        port: Number(input.port) || 22,
        username: String(input.username || ""),
        password:
          typeof input.password === "string" ? input.password : undefined,
        privateKey,
        passphrase:
          typeof input.passphrase === "string" ? input.passphrase : undefined,
        rememberForRemoteWorkspace: input.remember !== false,
      },
      signal,
    );
    const requestedRootPath = String(input.rootPath || "~");
    let rootPath: string;
    let rootPathWarning: string | undefined;
    try {
      rootPath = await resolved.resolveSshRoot(
        browserSessionId,
        requestId,
        requestedRootPath,
        signal,
      );
    } catch (error) {
      if (requestedRootPath === "~") throw error;
      rootPathWarning = `无法打开指定目录 ${requestedRootPath}：${error instanceof Error ? error.message : String(error)}`;
      rootPath = await resolved.resolveSshRoot(
        browserSessionId,
        requestId,
        "~",
        signal,
      );
    }
    const state = await resolved.adoptActiveSshRemote(
      browserSessionId,
      rootPath,
      String(input.name || "").trim() || undefined,
    );
    return {
      output: JSON.stringify(
        {
          ...result,
          rootPath,
          rootPathWarning,
          credential: publicSshCredentialReference(state.profile),
        },
        null,
        2,
      ),
      path: rootPath,
    };
  }
  if (name === "ssh_set_workspace") {
    const rootPath = await resolved.resolveSshRoot(
      browserSessionId,
      requestId,
      String(input.path || ""),
      signal,
    );
    const state = await resolved.adoptActiveSshRemote(
      browserSessionId,
      rootPath,
    );
    const activeRootPath = state.profile?.rootPath ?? rootPath;
    return {
      output: JSON.stringify(
        { connected: state.connected, rootPath: activeRootPath },
        null,
        2,
      ),
      path: activeRootPath,
    };
  }
  if (name === "ssh_run") {
    const requestedCommand = String(input.command || "");
    const remoteCommand = activeRemoteWorkspace
      ? sshWorkspaceCommand(activeRemoteWorkspace.rootPath, requestedCommand)
      : requestedCommand;
    const result = await resolved.runSshCommand(
      browserSessionId,
      requestId,
      remoteCommand,
      signal,
      {
        stdin: typeof input.stdin === "string" ? input.stdin : undefined,
        pty: Boolean(input.pty),
        timeoutMs: Math.min(
          600_000,
          Math.max(
            1_000,
            Number(input.timeoutMs) ||
              Math.max(180_000, defaultCommandTimeoutMs(remoteCommand)),
          ),
        ),
        onOutput: onProgress,
      },
    );
    const operationEvidence: CodingOperation[] = ["execute"];
    const purpose = String(input.purpose || "");
    if (result.exitCode === 0 && purpose === "modify")
      operationEvidence.push("modify");
    if (
      (result.exitCode === 0 || result.exitCode === 1) &&
      purpose !== "modify" &&
      (purpose === "inspect" || isInspectionCommand(requestedCommand))
    )
      operationEvidence.push("inspect");
    if (
      result.exitCode === 0 &&
      purpose !== "modify" &&
      (purpose === "validate" || isValidationCommand(requestedCommand))
    )
      operationEvidence.push("validate");
    return {
      ...result,
      command: remoteCommand,
      executed: true,
      mutationAttempted: purpose === "modify",
      operationEvidence,
    };
  }
  if (SSH_FILE_TOOLS.has(name)) {
    return (await resolved.executeSshFileOperation({
      root,
      browserSessionId,
      requestId,
      activityId,
      toolName: name,
      input,
      signal,
      remoteRootPath: activeRemoteWorkspace?.rootPath,
      onProgress,
      diffFor: ctx.diffFor,
    }))!;
  }
  if (name === "ssh_disconnect")
    return {
      output: resolved.disconnectSsh(browserSessionId)
        ? "SSH 连接已断开"
        : "当前任务没有活动的 SSH 连接",
    };
  throw new Error(`不支持的 SSH 工具：${name}`);
}
