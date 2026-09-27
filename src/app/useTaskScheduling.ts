import { useCallback, useEffect, useRef } from "react";
import { workspaceNameFromPath } from "../task-workspace";
import { uid, type QueuedChatMessage, type TaskRecord } from "../models";
import { errorMessage } from "../lib/format";
import { useEventCallback } from "../lib/use-event-callback";
import { nextQueuedMessageId } from "../task-status";
import type {
  ContextFile,
  ProviderConfig,
  ReasoningEffort,
  ScheduledTask,
} from "../types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ModelConfig } from "../types";
type TaskSchedulingBindings = {
  taskStorageReady: boolean;
  models: { provider: ProviderConfig; model: ModelConfig }[];
  selected: string;
  defaultReasoningEffort: ReasoningEffort;
  tasks: TaskRecord[];
  tasksRef: RefObject<TaskRecord[]>;
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  hydratedTaskIdsRef: RefObject<Set<string>>;
  contextByMessageRef: RefObject<Map<string, ContextFile[]>>;
  send: (
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) => Promise<void>;
  editingQueuedMessageId: string | undefined;
  summarizingTasks: ReadonlySet<string>;
};

export function useTaskScheduling({
  taskStorageReady,
  models,
  selected,
  defaultReasoningEffort,
  tasks,
  tasksRef,
  setTasks,
  hydratedTaskIdsRef,
  contextByMessageRef,
  send,
  editingQueuedMessageId,
  summarizingTasks,
}: TaskSchedulingBindings) {
  const scheduledTasksRef = useRef<ScheduledTask[]>([]);
  const scheduledRunsRef = useRef(new Set<string>());
  const startingQueuedRef = useRef(new Set<string>());
  const submit = useEventCallback(send);
  const reloadScheduledTasks = useCallback(() => {
    if (!window.kcode?.state) return;
    void window.kcode.state
      .load("scheduledTasks")
      .then((value) => {
        const next = Array.isArray(value) ? (value as ScheduledTask[]) : [];
        scheduledTasksRef.current = next;
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reloadScheduledTasks();
    window.addEventListener("kcode:schedules-updated", reloadScheduledTasks);
    return () =>
      window.removeEventListener(
        "kcode:schedules-updated",
        reloadScheduledTasks,
      );
  }, [reloadScheduledTasks]);
  useEffect(() => {
    const startQueued = (taskId: string, messageId: string) =>
      submit(undefined, messageId, taskId);
    if (!startQueued || !models.length) return;
    for (const task of tasks) {
      const messageId = nextQueuedMessageId(task);
      if (
        !messageId ||
        messageId === editingQueuedMessageId ||
        summarizingTasks.has(task.id) ||
        startingQueuedRef.current.has(task.id)
      )
        continue;
      startingQueuedRef.current.add(task.id);
      void startQueued(task.id, messageId).finally(() => {
        startingQueuedRef.current.delete(task.id);
      });
    }
  }, [editingQueuedMessageId, models, summarizingTasks, tasks, submit]);

  async function triggerScheduledTask(schedule: ScheduledTask) {
    if (scheduledRunsRef.current.has(schedule.id)) return;
    scheduledRunsRef.current.add(schedule.id);
    const updateSchedule = async (patch: Partial<ScheduledTask>) => {
      const next = scheduledTasksRef.current.map((item) =>
        item.id === schedule.id ? { ...item, ...patch } : item,
      );
      scheduledTasksRef.current = next;
      await window.kcode?.state.save("scheduledTasks", next);
    };
    try {
      const selection =
        schedule.modelSelection &&
        models.some(
          (item) =>
            `${item.provider.id}|${item.model.id}` === schedule.modelSelection,
        )
          ? schedule.modelSelection
          : models.some(
                (item) => `${item.provider.id}|${item.model.id}` === selected,
              )
            ? selected
            : models[0]
              ? `${models[0].provider.id}|${models[0].model.id}`
              : "";
      if (!selection) throw new Error("没有可用模型");
      let task = tasksRef.current.find(
        (item) => item.scheduledTaskId === schedule.id,
      );
      if (task?.runningId || task?.runStatus === "running")
        throw new Error("上一次定时运行尚未完成");
      if (!task) {
        const now = Date.now();
        task = {
          id: uid(),
          name: schedule.name,
          workspaceName: workspaceNameFromPath(schedule.workspacePath),
          workspacePath: schedule.workspacePath,
          createdAt: now,
          updatedAt: now,
          messages: [],
          activities: [],
          modelSelection: selection,
          reasoningEffort: schedule.reasoningEffort ?? defaultReasoningEffort,
          runStatus: "idle",
          scheduledTaskId: schedule.id,
        };
        hydratedTaskIdsRef.current.add(task.id);
        const nextTasks = [task, ...tasksRef.current];
        tasksRef.current = nextTasks;
        setTasks(nextTasks);
      } else if (task.modelSelection !== selection) {
        task = { ...task, modelSelection: selection };
        const nextTasks = tasksRef.current.map((item) =>
          item.id === task!.id ? task! : item,
        );
        tasksRef.current = nextTasks;
        setTasks(nextTasks);
      }
      const message: QueuedChatMessage = {
        id: uid(),
        role: "user",
        content: schedule.prompt,
        createdAt: Date.now(),
        queued: true,
      };
      contextByMessageRef.current.set(message.id, []);
      const nextTask = {
        ...task,
        messages: [...task.messages, message],
        updatedAt: Date.now(),
      };
      const nextTasks = tasksRef.current.map((item) =>
        item.id === nextTask.id ? nextTask : item,
      );
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      startingQueuedRef.current.add(nextTask.id);
      try {
        await submit(undefined, message.id, nextTask.id);
      } finally {
        startingQueuedRef.current.delete(nextTask.id);
      }
      await updateSchedule({ lastRunAt: Date.now(), lastError: undefined });
    } catch (error) {
      await updateSchedule({
        lastRunAt: Date.now(),
        lastError: errorMessage(error),
      });
    } finally {
      scheduledRunsRef.current.delete(schedule.id);
    }
  }

  const trigger = useEventCallback(triggerScheduledTask);
  useEffect(() => {
    if (!taskStorageReady || !models.length || !window.kcode?.state) return;
    const tick = () => {
      const now = Date.now();
      const due = scheduledTasksRef.current.filter(
        (item) => item.enabled && item.nextRunAt <= now,
      );
      if (!due.length) return;
      const ids = new Set(due.map((item) => item.id));
      const next = scheduledTasksRef.current.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              nextRunAt: now + Math.max(1, item.intervalMinutes) * 60_000,
            }
          : item,
      );
      scheduledTasksRef.current = next;
      void window.kcode.state.save("scheduledTasks", next);
      for (const item of due) void trigger(item);
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [models, taskStorageReady, trigger]);
}
