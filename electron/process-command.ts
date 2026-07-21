import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const FORCE_RESOLVE_AFTER_KILL_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const OUTPUT_PROGRESS_INTERVAL_MS = 100;

export function terminateChildProcess(
  child: ChildProcessWithoutNullStreams | { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
) {
  if (!child.pid) {
    try {
      child.kill();
    } catch {
      /* process already exited */
    }
    return;
  }

  if (process.platform === "win32") {
    // PowerShell commands often spawn grandchildren such as ssh.exe. A plain
    // child.kill() only stops the shell and leaves the remote session hanging.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref?.();
    try {
      child.kill();
    } catch {
      /* taskkill already removed the process */
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* process already exited */
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* process group kill is best-effort */
  }
}

export type SpawnedCommandResult = {
  output: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  idleTimedOut?: boolean;
};

function formatSeconds(ms: number) {
  return Math.max(1, Math.round(ms / 1_000));
}

export function runSpawnedCommand(options: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Kill the process if no stdout/stderr arrives for this long. */
  idleTimeoutMs?: number;
  /** Override the progress heartbeat interval, primarily for deterministic tests. */
  heartbeatIntervalMs?: number;
  onOutput?: (output: string) => void;
  maxOutputBytes?: number;
}): Promise<SpawnedCommandResult> {
  const {
    executable,
    args,
    cwd,
    env,
    signal,
    timeoutMs = 30_000,
    idleTimeoutMs,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    onOutput,
    maxOutputBytes = 100_000,
  } = options;

  return new Promise<SpawnedCommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env,
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let timedOut = false;
    let idleTimedOut = false;
    let forceResolved = false;
    let settled = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let lastHeartbeatAt = 0;
    let progressTimer: NodeJS.Timeout | undefined;

    const decode = (bytes: Buffer) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return new TextDecoder("gb18030").decode(bytes);
      }
    };

    const processOutput = () => decode(Buffer.concat(chunks)).slice(-maxOutputBytes);

    const progressText = () => {
      const base = processOutput().trimEnd();
      const silentMs = Date.now() - lastOutputAt;
      const elapsedMs = Date.now() - startedAt;
      if (silentMs < heartbeatIntervalMs) return base;
      const note =
        silentMs >= heartbeatIntervalMs
          ? `[进度] 进程仍在运行，已执行 ${formatSeconds(elapsedMs)} 秒，最近 ${formatSeconds(silentMs)} 秒没有新输出。若长时间无反馈，可点停止强制终止。`
          : "";
      return base ? `${base}\n${note}` : note;
    };

    const emitProgress = (force = false) => {
      if (!onOutput) return;
      const now = Date.now();
      if (!force && now - lastHeartbeatAt < Math.max(1, heartbeatIntervalMs - 10))
        return;
      lastHeartbeatAt = now;
      onOutput(progressText());
    };

    const scheduleOutputProgress = () => {
      if (!onOutput || progressTimer) return;
      progressTimer = setTimeout(() => {
        progressTimer = undefined;
        emitProgress(true);
      }, OUTPUT_PROGRESS_INTERVAL_MS);
    };

    const append = (chunk: Buffer) => {
      chunks.push(chunk);
      byteLength += chunk.length;
      while (byteLength > maxOutputBytes && chunks.length > 1)
        byteLength -= chunks.shift()!.length;
      lastOutputAt = Date.now();
      scheduleOutputProgress();
    };

    const finish = (result: SpawnedCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(idleTimer);
      if (progressTimer) clearTimeout(progressTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const forceFinish = (cancelled: boolean) => {
      if (settled) return;
      forceResolved = true;
      terminateChildProcess(child);
      const output = progressText();
      const reason = cancelled
        ? "命令已取消。"
        : idleTimedOut
          ? `命令超过 ${formatSeconds(idleTimeoutMs || 0)} 秒没有新输出，已判定卡住并终止。`
          : timedOut
            ? `命令执行超时（${formatSeconds(timeoutMs)} 秒），已终止。`
            : "";
      finish({
        output: reason ? `${output.trimEnd()}\n${reason}`.trimStart() : output,
        exitCode: -1,
        timedOut: timedOut || idleTimedOut,
        cancelled,
        idleTimedOut,
      });
    };

    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armForceResolve = (cancelled: boolean) => {
      if (forceTimer) return;
      forceTimer = setTimeout(
        () => forceFinish(cancelled),
        FORCE_RESOLVE_AFTER_KILL_MS,
      );
    };

    const armIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        idleTimedOut = true;
        terminateChildProcess(child);
        armForceResolve(false);
      }, idleTimeoutMs);
    };

    const onAbort = () => {
      terminateChildProcess(child);
      armForceResolve(true);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk);
      armIdleTimer();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(chunk);
      armIdleTimer();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
      armForceResolve(false);
    }, timeoutMs);

    const heartbeatTimer = setInterval(() => emitProgress(), heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    armIdleTimer();
    // Immediate first heartbeat so the UI is not empty while waiting.
    emitProgress(true);

    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled || forceResolved) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      const output = processOutput();
      if (timedOut || idleTimedOut)
        finish({
          output:
            `${output.trimEnd()}\n${
              idleTimedOut
                ? `命令超过 ${formatSeconds(idleTimeoutMs || 0)} 秒没有新输出，已判定卡住并终止。`
                : `命令执行超时（${formatSeconds(timeoutMs)} 秒），已终止。`
            }`.trimStart(),
          exitCode: code ?? -1,
          timedOut: true,
          cancelled: false,
          idleTimedOut,
        });
      else if (signal.aborted)
        finish({
          output: `${output.trimEnd()}\n命令已取消。`.trimStart(),
          exitCode: code ?? -1,
          timedOut: false,
          cancelled: true,
        });
      else
        finish({
          output,
          exitCode: code ?? -1,
          timedOut: false,
          cancelled: false,
        });
    });

    if (signal.aborted) onAbort();
  });
}

export function isLikelyNetworkCommand(command: string) {
  return /\b(ssh|scp|sftp|plink|pscp|putty|ssh-keyscan|curl|wget|Invoke-WebRequest|Invoke-RestMethod|git\s+(clone|fetch|pull|push)|npm\s+(install|ci|publish)|pnpm\s+install|yarn\s+install|docker\s+pull)\b/i.test(
    command,
  );
}
