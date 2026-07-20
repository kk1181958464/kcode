import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

const MAX_OUTPUT_BYTES = 200_000;
const MAX_REMOTE_FILE_BYTES = 2_000_000;
const SFTP_UPLOAD_IDLE_TIMEOUT_MS = 90_000;
const SFTP_UPLOAD_TIMEOUT_MS = 15 * 60_000;

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

type SshSession = {
  client: Client;
  requestId: string;
  host: string;
  port: number;
  username: string;
};

type RemoteUndoSnapshot = {
  sessionId: string;
  requestId: string;
  remotePath: string;
  before: string;
  after: string;
  existed: boolean;
  mode?: number;
  host: string;
  port: number;
  username: string;
};

export type SshConnectInput = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

const sessions = new Map<string, SshSession>();
const remoteUndoSnapshots = new Map<string, RemoteUndoSnapshot>();

type SshCredentialKind = "password" | "private-key" | "password-and-key";

function friendlySshError(error: unknown, credentialKind?: SshCredentialKind) {
  const message = error instanceof Error ? error.message : String(error);
  if (/SSH .*已取消/.test(message)) return message;
  if (/SSH 远程命令执行超时/.test(message)) return message;
  if (
    /Cannot parse privateKey|private key.*(?:parse|format)|unsupported key/i.test(
      message,
    )
  )
    return "SSH 私钥无法解析，请确认传入的是完整私钥内容，并检查私钥格式和口令。";
  if (
    /authentication|all configured authentication methods failed/i.test(message)
  ) {
    if (credentialKind === "password")
      return "SSH 密码认证失败，请检查用户名和密码，并确认服务器允许密码或键盘交互认证。";
    if (credentialKind === "private-key")
      return "SSH 私钥认证失败，请检查用户名、私钥内容、私钥口令及服务器 authorized_keys。";
    return "SSH 身份验证失败，请检查用户名、密码、私钥、私钥口令及服务器允许的认证方式。";
  }
  if (/timed out|timeout/i.test(message))
    return "SSH 连接超时，请检查服务器地址、端口和防火墙。";
  if (/ECONNREFUSED/i.test(message))
    return "SSH 连接被服务器拒绝，请检查端口和 SSH 服务状态。";
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return "SSH 服务器地址无法解析。";
  if (/ECONNRESET|not connected|No response from server/i.test(message))
    return "SSH 连接已断开。";
  return `SSH 操作失败：${message}`;
}

export function normalizeSshPrivateKey(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replace(/\\r\\n|\\n/g, "\n")
    : trimmed;
}

function getSession(sessionId: string, requestId: string) {
  const session = sessions.get(sessionId);
  if (!session)
    throw new Error("当前任务尚未连接 SSH 服务器，请先调用 SSH 连接工具。");
  session.requestId = requestId;
  return session;
}

export async function connectSsh(
  sessionId: string,
  requestId: string,
  input: SshConnectInput,
  signal: AbortSignal,
) {
  const host = input.host.trim();
  const username = input.username.trim();
  const privateKey = normalizeSshPrivateKey(input.privateKey);
  const port = Number(input.port) || 22;
  if (!host) throw new Error("缺少 SSH 服务器地址。");
  if (!username) throw new Error("缺少 SSH 用户名。");
  if (!input.password && !privateKey)
    throw new Error("缺少 SSH 密码或私钥内容。");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数。");

  const client = new Client();
  const credentialKind: SshCredentialKind =
    input.password && privateKey
      ? "password-and-key"
      : privateKey
        ? "private-key"
        : "password";
  if (input.password)
    client.on(
      "keyboard-interactive",
      (_name, _instructions, _language, prompts, finish) =>
        finish(prompts.map(() => input.password!)),
    );
  const handleClientError = () => {
    for (const [key, value] of sessions)
      if (value.client === client) sessions.delete(key);
  };
  client.on("error", handleClientError);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      client.removeListener("ready", ready);
      client.removeListener("error", failed);
      if (error) {
        client.destroy();
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new Error("SSH 连接已取消。"));
    const ready = () => finish();
    const failed = (error: Error) =>
      finish(new Error(friendlySshError(error, credentialKind)));
    signal.addEventListener("abort", abort, { once: true });
    client.once("ready", ready);
    client.once("error", failed);
    try {
      client.connect({
        host,
        port,
        username,
        password: input.password,
        privateKey,
        passphrase: input.passphrase,
        tryKeyboard: Boolean(input.password),
        readyTimeout: 30_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      });
    } catch (error) {
      finish(new Error(friendlySshError(error, credentialKind)));
    }
    if (signal.aborted) abort();
  });
  if (signal.aborted) {
    client.destroy();
    throw new Error("SSH 连接已取消。");
  }
  const previous = sessions.get(sessionId);
  const session: SshSession = {
    client,
    requestId,
    host,
    port,
    username,
  };
  sessions.set(sessionId, session);
  client.on("close", () => {
    for (const [key, value] of sessions)
      if (value.client === client) sessions.delete(key);
  });
  previous?.client.end();
  return {
    connected: true,
    host,
    port,
    username,
  };
}

export function disconnectSsh(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  session.client.end();
  return true;
}

export function adoptSshSession(fromSessionId: string, toSessionId: string) {
  const incoming = sessions.get(fromSessionId);
  if (!incoming) throw new Error("待切换的 SSH 连接不存在。");
  const previous = sessions.get(toSessionId);
  sessions.delete(fromSessionId);
  sessions.set(toSessionId, incoming);
  previous?.client.end();
}

function appendLimited(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
) {
  const value =
    chunk.length > MAX_OUTPUT_BYTES ? chunk.subarray(-MAX_OUTPUT_BYTES) : chunk;
  chunks.push(value);
  state.bytes += value.length;
  while (state.bytes > MAX_OUTPUT_BYTES && chunks.length > 1)
    state.bytes -= chunks.shift()!.length;
}

export async function runSshCommand(
  sessionId: string,
  requestId: string,
  command: string,
  signal: AbortSignal,
  options: {
    stdin?: string;
    pty?: boolean;
    timeoutMs?: number;
    onOutput?: (output: string) => void;
  } = {},
) {
  if (!command.trim()) throw new Error("缺少远程命令。");
  const session = getSession(sessionId, requestId);
  return new Promise<{ output: string; exitCode: number }>(
    (resolve, reject) => {
      let channel: ClientChannel | undefined;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { bytes: 0 };
      const stderrState = { bytes: 0 };
      let lastProgressAt = 0;
      const currentOutput = (signalName?: string) => {
        const out = Buffer.concat(stdout)
          .toString("utf8")
          .slice(-MAX_OUTPUT_BYTES);
        const err = Buffer.concat(stderr)
          .toString("utf8")
          .slice(-MAX_OUTPUT_BYTES);
        return [
          out.trimEnd(),
          err ? `stderr:\n${err.trimEnd()}` : "",
          signalName ? `signal: ${signalName}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      };
      const publishProgress = () => {
        const now = Date.now();
        if (!options.onOutput || now - lastProgressAt < 250) return;
        lastProgressAt = now;
        const output = currentOutput();
        if (output) options.onOutput(output);
      };
      const finish = (error?: unknown, code = -1, signalName?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) return reject(new Error(friendlySshError(error)));
        resolve({
          output: currentOutput(signalName) || "远程命令未产生输出",
          exitCode: code,
        });
      };
      const abort = () => {
        channel?.close();
        finish(new Error("SSH 命令已取消。"));
      };
      signal.addEventListener("abort", abort, { once: true });
      const timeoutMs = Math.min(
        600_000,
        Math.max(1_000, options.timeoutMs ?? 180_000),
      );
      timer = setTimeout(() => {
        channel?.close();
        finish(
          new Error(
            `SSH 远程命令执行超时（${Math.round(timeoutMs / 1_000)} 秒），命令通道已关闭。`,
          ),
        );
      }, timeoutMs);
      session.client.exec(
        command,
        { pty: Boolean(options.pty) },
        (error, stream) => {
          if (error) return finish(error);
          channel = stream;
          stream.on("data", (chunk: Buffer) => {
            appendLimited(stdout, chunk, stdoutState);
            publishProgress();
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            appendLimited(stderr, chunk, stderrState);
            publishProgress();
          });
          stream.once("error", (streamError: Error) => finish(streamError));
          stream.once("close", (code: number, signalName: string) =>
            finish(undefined, code ?? -1, signalName),
          );
          if (options.stdin !== undefined) stream.end(options.stdin);
          if (signal.aborted) abort();
        },
      );
    },
  );
}

export function openSshForward(
  sessionId: string,
  requestId: string,
  destinationHost: string,
  destinationPort: number,
  signal: AbortSignal,
) {
  const session = getSession(sessionId, requestId);
  return new Promise<ClientChannel>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, stream?: ClientChannel) => {
      if (settled) {
        stream?.destroy();
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(new Error(friendlySshError(error)));
      else if (stream) resolve(stream);
    };
    const abort = () => finish(new Error("SSH 通道连接已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    session.client.forwardOut(
      "127.0.0.1",
      0,
      destinationHost,
      destinationPort,
      (error, stream) => finish(error, stream),
    );
    if (signal.aborted) abort();
  });
}

function getSftp(session: SshSession, signal: AbortSignal) {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, sftp?: SFTPWrapper) => {
      if (settled) {
        sftp?.end();
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(new Error(friendlySshError(error)));
      else if (sftp) {
        sftp.on("error", () => undefined);
        resolve(sftp);
      }
    };
    const abort = () => finish(new Error("SFTP 操作已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    session.client.sftp((error, sftp) => finish(error, sftp));
    if (signal.aborted) abort();
  });
}

function sftpOperation<T>(
  sftp: SFTPWrapper,
  signal: AbortSignal,
  start: (complete: (error?: Error, value?: T) => void) => void,
) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => {
      sftp.end();
      finish(new Error("SFTP 操作已取消。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    start(finish);
    if (signal.aborted) abort();
  });
}

function statRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  signal: AbortSignal,
) {
  return sftpOperation<
    Awaited<Parameters<Parameters<SFTPWrapper["stat"]>[1]>[1]>
  >(sftp, signal, (complete) =>
    sftp.stat(remotePath, (error, stats) => complete(error, stats)),
  );
}

function lstatRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  signal: AbortSignal,
) {
  return sftpOperation<
    Awaited<Parameters<Parameters<SFTPWrapper["lstat"]>[1]>[1]>
  >(sftp, signal, (complete) =>
    sftp.lstat(remotePath, (error, stats) => complete(error, stats)),
  );
}

async function readRemoteText(
  sftp: SFTPWrapper,
  remotePath: string,
  signal: AbortSignal,
) {
  const stats = await statRemote(sftp, remotePath, signal);
  if (!stats.isFile()) throw new Error("远程路径不是普通文件。");
  if (stats.size > MAX_REMOTE_FILE_BYTES)
    throw new Error(
      `远程文件超过 ${MAX_REMOTE_FILE_BYTES / 1_000_000} MB 读取上限。`,
    );
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const stream = sftp.createReadStream(remotePath, {
      start: 0,
      end: MAX_REMOTE_FILE_BYTES,
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) return reject(error);
      const data = Buffer.concat(chunks);
      if (data.includes(0))
        return reject(new Error("远程文件是二进制文件，不能作为文本读取。"));
      resolve(data.toString("utf8"));
    };
    const abort = () => {
      stream.destroy();
      finish(new Error("SFTP 读取已取消。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REMOTE_FILE_BYTES) {
        stream.destroy();
        finish(
          new Error(
            `远程文件超过 ${MAX_REMOTE_FILE_BYTES / 1_000_000} MB 读取上限。`,
          ),
        );
      } else chunks.push(chunk);
    });
    stream.once("error", (error: Error) => finish(error));
    stream.once("end", () => finish());
    if (signal.aborted) abort();
  });
}

function writeRemoteAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string,
  signal: AbortSignal,
  mode?: number,
) {
  const temporary = `${remotePath}.kcode-${randomUUID()}.tmp`;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const cleanup = (error: unknown) =>
      sftp.unlink(temporary, () => finish(error));
    const abort = () => cleanup(new Error("SFTP 写入已取消。"));
    signal.addEventListener("abort", abort, { once: true });
    const commit = () => {
      if (settled) return;
      signal.removeEventListener("abort", abort);
      sftp.ext_openssh_rename(temporary, remotePath, (posixError) => {
        if (!posixError) return finish();
        sftp.rename(temporary, remotePath, (renameError) =>
          renameError ? cleanup(renameError) : finish(),
        );
      });
    };
    sftp.writeFile(temporary, content, "utf8", (writeError) => {
      if (writeError) return cleanup(writeError);
      if (signal.aborted) return abort();
      if (mode !== undefined)
        sftp.setstat(temporary, { mode }, (modeError) =>
          modeError ? cleanup(modeError) : commit(),
        );
      else commit();
    });
    if (signal.aborted) abort();
  });
}

export async function listSshDirectory(
  sessionId: string,
  requestId: string,
  remotePath: string,
  signal: AbortSignal,
) {
  const session = getSession(sessionId, requestId);
  const sftp = await getSftp(session, signal);
  try {
    const entries = await sftpOperation<
      Parameters<SFTPWrapper["readdir"]>[1] extends (
        error: Error | undefined,
        list: infer T,
      ) => void
        ? T
        : never
    >(sftp, signal, (complete) =>
      sftp.readdir(remotePath || ".", (error, list) =>
        complete(error ? new Error(friendlySshError(error)) : undefined, list),
      ),
    );
    return entries.slice(0, 1000).map((entry) => ({
      name: entry.filename,
      type: entry.attrs.isDirectory() ? "directory" : "file",
      size: entry.attrs.size,
      modifiedAt: entry.attrs.mtime,
      mode: entry.attrs.mode,
    }));
  } finally {
    sftp.end();
  }
}

export async function readSshFile(
  sessionId: string,
  requestId: string,
  remotePath: string,
  signal: AbortSignal,
) {
  if (!remotePath) throw new Error("缺少远程文件路径。");
  const session = getSession(sessionId, requestId);
  const sftp = await getSftp(session, signal);
  try {
    return await readRemoteText(sftp, remotePath, signal);
  } finally {
    sftp.end();
  }
}

export async function writeSshFile(
  sessionId: string,
  requestId: string,
  activityId: string,
  remotePath: string,
  content: string,
  signal: AbortSignal,
) {
  if (!remotePath) throw new Error("缺少远程文件路径。");
  if (Buffer.byteLength(content) > MAX_REMOTE_FILE_BYTES)
    throw new Error(
      `远程文件超过 ${MAX_REMOTE_FILE_BYTES / 1_000_000} MB 写入上限。`,
    );
  const session = getSession(sessionId, requestId);
  const sftp = await getSftp(session, signal);
  let before = "";
  let existed = true;
  let mode: number | undefined;
  try {
    try {
      const linkStats = await lstatRemote(sftp, remotePath, signal);
      if (linkStats.isSymbolicLink())
        throw new Error("为避免替换符号链接本身，不支持直接覆盖远程符号链接。");
      mode = linkStats.mode;
      before = await readRemoteText(sftp, remotePath, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such file|not found|不存在/i.test(message)) existed = false;
      else throw error;
    }
    await writeRemoteAtomic(sftp, remotePath, content, signal, mode);
    remoteUndoSnapshots.set(activityId, {
      sessionId,
      requestId,
      remotePath,
      before,
      after: content,
      existed,
      mode,
      host: session.host,
      port: session.port,
      username: session.username,
    });
    return { bytes: Buffer.byteLength(content), before, after: content };
  } finally {
    sftp.end();
  }
}

export async function uploadSshFile(
  sessionId: string,
  requestId: string,
  localPath: string,
  remotePath: string,
  signal: AbortSignal,
  onProgress: (output: string) => void = () => undefined,
) {
  if (!localPath) throw new Error("缺少本地文件路径。");
  if (!remotePath) throw new Error("缺少远程文件路径。");
  let localSize: number;
  try {
    const stats = statSync(localPath);
    if (!stats.isFile()) throw new Error("本地路径不是普通文件。");
    localSize = stats.size;
  } catch (error) {
    if (error instanceof Error && /不是普通文件/.test(error.message)) throw error;
    throw new Error(`无法读取本地文件：${localPath}`);
  }
  const session = getSession(sessionId, requestId);
  const sftp = await getSftp(session, signal);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastUploaded = 0;
      let idleTimer: NodeJS.Timeout | undefined;
      const totalTimer = setTimeout(() => {
        finish(new Error("SFTP 上传总超时（15 分钟），请检查远程磁盘和网络连接。"));
      }, SFTP_UPLOAD_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener("abort", abort);
        if (error) {
          sftp.end();
          reject(error);
        } else resolve();
      };
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          finish(new Error("SFTP 上传超过 90 秒没有进度，请检查远程磁盘和网络连接。"));
        }, SFTP_UPLOAD_IDLE_TIMEOUT_MS);
      };
      const abort = () => finish(new Error("SFTP 上传已取消。"));
      signal.addEventListener("abort", abort, { once: true });
      armIdleTimer();
      try {
        sftp.fastPut(
          localPath,
          remotePath,
          {
            step: (transferred, _chunk, total) => {
              if (settled || transferred <= lastUploaded) return;
              lastUploaded = transferred;
              armIdleTimer();
              const percent = total > 0 ? Math.floor((transferred / total) * 100) : 0;
              onProgress(
                `已上传 ${formatBytes(transferred)} / ${formatBytes(total)}（${percent}%）`,
              );
            },
          },
          (error) =>
            finish(error ? new Error(friendlySshError(error)) : undefined),
        );
      } catch (error) {
        finish(new Error(friendlySshError(error)));
      }
      if (signal.aborted) abort();
    });
    return { bytes: localSize };
  } finally {
    sftp.end();
  }
}

export async function downloadSshFile(
  sessionId: string,
  requestId: string,
  remotePath: string,
  localPath: string,
  signal: AbortSignal,
) {
  if (!remotePath) throw new Error("缺少远程文件路径。");
  if (!localPath) throw new Error("缺少本地保存路径。");
  const session = getSession(sessionId, requestId);
  const sftp = await getSftp(session, signal);
  try {
    const stats = await statRemote(sftp, remotePath, signal);
    if (!stats.isFile()) throw new Error("远程路径不是普通文件。");
    mkdirSync(path.dirname(localPath), { recursive: true });
    await sftpOperation<void>(sftp, signal, (complete) =>
      sftp.fastGet(remotePath, localPath, (error) =>
        complete(error ? new Error(friendlySshError(error)) : undefined),
      ),
    );
    return { bytes: stats.size };
  } finally {
    sftp.end();
  }
}

export async function undoSshActivity(activityId: string, force = false) {
  const snapshot = remoteUndoSnapshots.get(activityId);
  if (!snapshot) return undefined;
  const session = getSession(snapshot.sessionId, snapshot.requestId);
  if (
    session.host !== snapshot.host ||
    session.port !== snapshot.port ||
    session.username !== snapshot.username
  )
    return {
      success: false,
      message: "当前 SSH 连接与生成此恢复记录的服务器不一致，已阻止恢复。",
    };
  const signal = new AbortController().signal;
  const sftp = await getSftp(session, signal);
  try {
    let current = "";
    try {
      current = await readRemoteText(sftp, snapshot.remotePath, signal);
    } catch {
      if (!force)
        return {
          success: false,
          conflict: true,
          message: "远程文件在这个版本之后已被删除或无法读取",
        };
    }
    if (current !== snapshot.after && !force)
      return {
        success: false,
        conflict: true,
        message: "远程文件在这个版本之后又被修改过",
      };
    if (snapshot.existed)
      await writeRemoteAtomic(
        sftp,
        snapshot.remotePath,
        snapshot.before,
        signal,
        snapshot.mode,
      );
    else
      await new Promise<void>((resolve, reject) =>
        sftp.unlink(snapshot.remotePath, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    remoteUndoSnapshots.delete(activityId);
    return {
      success: true,
      message: snapshot.existed
        ? "已恢复远程文件修改前内容"
        : "已删除本次新建的远程文件",
    };
  } finally {
    sftp.end();
  }
}

export function cleanupSshSessions(ids: string[], activityIds: string[] = []) {
  const targets = new Set(ids);
  const activities = new Set(activityIds);
  for (const [activityId, snapshot] of remoteUndoSnapshots)
    if (activities.has(activityId) || targets.has(snapshot.requestId))
      remoteUndoSnapshots.delete(activityId);
  for (const [sessionId, session] of sessions)
    if (targets.has(sessionId) || targets.has(session.requestId))
      disconnectSsh(sessionId);
}

export function closeAllSshSessions() {
  for (const sessionId of [...sessions.keys()]) disconnectSsh(sessionId);
  remoteUndoSnapshots.clear();
}
