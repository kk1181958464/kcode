import type { TaskRecord } from "./models";

export type ActiveTaskRuntime = {
  taskId: string;
  requestId: string;
  startedAt: number;
};

type RuntimeListener = () => void;

/**
 * Small, high-frequency runtime projection. Conversation messages and tool
 * output can update many times per second; the sidebar only needs to know
 * which task currently owns a request. Keeping that signal separate also
 * prevents a stale completion from clearing a newer request in another task.
 */
export class TaskRuntimeStore {
  private readonly active = new Map<string, ActiveTaskRuntime>();
  private readonly listeners = new Set<RuntimeListener>();
  private revision = 0;

  subscribe = (listener: RuntimeListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.revision;

  private publish() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  start(taskId: string, requestId: string, startedAt = Date.now()) {
    const current = this.active.get(taskId);
    if (
      current?.requestId === requestId &&
      current.startedAt === startedAt
    )
      return;
    this.active.set(taskId, { taskId, requestId, startedAt });
    this.publish();
  }

  ensureRunning(taskId: string, requestId: string, startedAt = Date.now()) {
    const current = this.active.get(taskId);
    if (current?.requestId === requestId) return;
    this.active.set(taskId, { taskId, requestId, startedAt });
    this.publish();
  }

  finish(taskId: string, requestId: string) {
    const current = this.active.get(taskId);
    if (!current || current.requestId !== requestId) return false;
    this.active.delete(taskId);
    this.publish();
    return true;
  }

  clear(taskId: string) {
    if (!this.active.delete(taskId)) return;
    this.publish();
  }

  get(taskId: string) {
    return this.active.get(taskId);
  }

  overlayTasks(tasks: readonly TaskRecord[]) {
    return tasks.map((task) => {
      const runtime = this.active.get(task.id);
      if (!runtime || task.runningId === runtime.requestId) return task;
      return {
        ...task,
        runningId: runtime.requestId,
        runStatus: "running" as const,
        startedAt: runtime.startedAt,
      };
    });
  }

  resetForTest() {
    this.active.clear();
    this.revision = 0;
    this.listeners.clear();
  }
}

export const taskRuntimeStore = new TaskRuntimeStore();

