import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { localShellInvocation } from "./local-shell";
import { terminateChildProcess } from "./process-command";
import {
  registerManagedProcess,
  unregisterManagedProcess,
  terminateAllManagedProcesses,
  terminateManagedProcess,
} from "./process-registry";

export type BackgroundProcess = {
  root: string;
  requestId: string;
  child: ChildProcess;
  output: string;
  exitCode?: number;
};

export class BackgroundProcessManager {
  private readonly processes = new Map<string, BackgroundProcess>();

  async start(root: string, requestId: string, script: string) {
    if (!script) throw new Error("缺少进程命令");
    const id = randomUUID();
    const shell = localShellInvocation(script);
    const child = spawn(shell.executable, shell.args, {
      cwd: root, windowsHide: true, shell: false, detached: process.platform !== "win32",
    });
    const record: BackgroundProcess = { root, requestId, child, output: "" };
    const append = (chunk: Buffer) => {
      record.output = (record.output + new TextDecoder("utf-8").decode(chunk)).slice(-100_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("close", (code) => { record.exitCode = code ?? -1; void unregisterManagedProcess(id); });
    child.on("error", (error) => {
      record.exitCode = -1;
      record.output = `${record.output}\n${error.message}`.trim();
      void unregisterManagedProcess(id);
    });
    if (!child.pid) { terminateChildProcess(child); throw new Error("后台进程启动失败：未获得进程 ID"); }
    try {
      await registerManagedProcess({ id, pid: child.pid, processGroupId: process.platform === "win32" ? undefined : child.pid, requestId, workspacePath: root, startedAt: Date.now() });
    } catch (error) {
      terminateChildProcess(child);
      throw new Error(`后台进程登记失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.processes.set(id, record);
    return { id, script };
  }

  get(id: string, root: string) {
    const process = this.processes.get(id);
    if (!process || process.root !== root) throw new Error("后台进程不存在或不属于当前工作区");
    return process;
  }

  async stop(id: string, root: string) {
    const process = this.get(id, root);
    terminateChildProcess(process.child);
    this.processes.delete(id);
    await unregisterManagedProcess(id);
  }

  async cleanup(requestIds: Set<string>) {
    const removed: string[] = [];
    for (const [id, process] of this.processes) if (requestIds.has(process.requestId)) {
      terminateChildProcess(process.child); this.processes.delete(id); removed.push(id);
    }
    await Promise.allSettled(removed.map(unregisterManagedProcess));
  }

  async cleanupAll() {
    for (const process of this.processes.values()) terminateChildProcess(process.child);
    this.processes.clear();
    await terminateAllManagedProcesses();
  }

  async stopById(id: string) {
    const process = this.processes.get(id);
    if (process) { terminateChildProcess(process.child); this.processes.delete(id); }
    await terminateManagedProcess(id);
  }
}

export const backgroundProcessManager = new BackgroundProcessManager();
