import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type ManagedProcessRecord = {
  id: string;
  pid: number;
  processGroupId?: number;
  requestId: string;
  workspacePath: string;
  startedAt: number;
};

type RegistryFile = {
  version: 1;
  processes: ManagedProcessRecord[];
};

type ProcessTerminator = (record: ManagedProcessRecord) => Promise<void>;

let temporaryFileCounter = 0;

function isManagedProcessRecord(value: unknown): value is ManagedProcessRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagedProcessRecord>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.requestId === "string" &&
    typeof record.workspacePath === "string" &&
    typeof record.startedAt === "number"
  );
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function taskkill(pid: number) {
  return new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/F", "/PID", String(pid), "/T"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export async function terminateRegisteredProcess(record: ManagedProcessRecord) {
  if (!processExists(record.pid)) return;
  if (process.platform === "win32") {
    await taskkill(record.pid);
    return;
  }

  const targets = [
    record.processGroupId ? -record.processGroupId : undefined,
    record.pid,
  ].filter((target): target is number => typeof target === "number");
  const signal = (sig: NodeJS.Signals) => {
    for (const target of targets) {
      try {
        process.kill(target, sig);
      } catch {
        // The process may have exited between the check and the signal.
      }
    }
  };
  signal("SIGTERM");
  // Give the process a grace period to exit cleanly, then escalate to
  // SIGKILL so a process that ignores or slowly handles SIGTERM (build
  // tools, signal-trapping scripts) is actually terminated on stop.
  const graceMs = 2_000;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processExists(record.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processExists(record.pid)) signal("SIGKILL");
}

export class ManagedProcessRegistry {
  private readonly records = new Map<string, ManagedProcessRecord>();
  private loadPromise: Promise<void> | undefined;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly terminate: ProcessTerminator = terminateRegisteredProcess,
    private readonly isAlive: (pid: number) => boolean = processExists,
  ) {}

  private load() {
    // Cache the in-flight promise so concurrent callers await the same read
    // instead of racing: a boolean flag would let a second caller proceed on
    // an empty map and persist over the on-disk records before readFile lands.
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk() {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      if (!Array.isArray(parsed.processes)) throw new Error("invalid registry");
      for (const record of parsed.processes)
        if (isManagedProcessRecord(record)) this.records.set(record.id, record);
    } catch {
      const quarantinePath = `${this.filePath}.corrupt.${Date.now()}`;
      await rename(this.filePath, quarantinePath).catch(() => undefined);
    }
  }

  private persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${++temporaryFileCounter}.tmp`;
      const payload: RegistryFile = {
        version: 1,
        processes: [...this.records.values()],
      };
      await writeFile(
        tempPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      try {
        await rename(tempPath, this.filePath);
      } catch {
        await rm(this.filePath, { force: true });
        await rename(tempPath, this.filePath);
      }
    });
    return this.writeQueue;
  }

  async recover() {
    await this.load();
    const stale = [...this.records.values()];
    await Promise.allSettled(stale.map((record) => this.terminate(record)));
    this.records.clear();
    await this.persist();
    return stale.length;
  }

  async register(record: ManagedProcessRecord) {
    await this.load();
    this.records.set(record.id, record);
    await this.persist();
  }

  async remove(id: string) {
    await this.load();
    if (!this.records.delete(id)) return;
    await this.persist();
  }

  async terminateAll() {
    await this.load();
    const active = [...this.records.values()];
    await Promise.allSettled(active.map((record) => this.terminate(record)));
    this.records.clear();
    await this.persist();
    return active.length;
  }

  async terminateOne(id: string) {
    await this.load();
    const record = this.records.get(id);
    if (!record) return false;
    await this.terminate(record);
    this.records.delete(id);
    await this.persist();
    return true;
  }

  /** Remove records whose process exited without sending an explicit cleanup. */
  async pruneExited() {
    await this.load();
    const exited = [...this.records.values()].filter(
      (record) => !this.isAlive(record.pid),
    );
    if (!exited.length) return 0;
    exited.forEach((record) => this.records.delete(record.id));
    await this.persist();
    return exited.length;
  }

  async snapshot() {
    await this.load();
    return [...this.records.values()];
  }
}

let registry: ManagedProcessRegistry | undefined;
let supervisorTimer: ReturnType<typeof setInterval> | undefined;

export async function initializeManagedProcessRegistry(userDataPath: string) {
  stopManagedProcessSupervisor();
  registry = new ManagedProcessRegistry(
    path.join(userDataPath, "runtime", "managed-processes.json"),
  );
  return registry.recover();
}

export function startManagedProcessSupervisor(intervalMs = 30_000) {
  stopManagedProcessSupervisor();
  supervisorTimer = setInterval(() => {
    void registry?.pruneExited().catch(() => undefined);
  }, Math.max(5_000, intervalMs));
  supervisorTimer.unref?.();
}

export function stopManagedProcessSupervisor() {
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = undefined;
}

export async function registerManagedProcess(record: ManagedProcessRecord) {
  await registry?.register(record);
}

export async function unregisterManagedProcess(id: string) {
  await registry?.remove(id);
}

export async function terminateAllManagedProcesses() {
  return (await registry?.terminateAll()) ?? 0;
}

export async function managedProcessSnapshot() {
  return (await registry?.snapshot()) ?? [];
}

export async function terminateManagedProcess(id: string) {
  await registry?.terminateOne(id);
  return managedProcessSnapshot();
}
