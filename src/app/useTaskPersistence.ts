import { taskSaveDiff } from "../task-save-diff";
import { type TaskPagingState } from "./app-utils";
import { useEffect, useRef, useState } from "react";
import { type TaskDrafts, type TaskRecord } from "../models";
import { taskRuntimeStore } from "../task-runtime-store";
import { normalizeStoredTask } from "../lib/storage";
import { errorMessage } from "../lib/format";
import type { AgentActivity, ChatMessage } from "../types";
import type { Dispatch, RefObject, SetStateAction } from "react";
type TaskPersistenceBindings = {
  tasks: TaskRecord[];
  tasksRef: RefObject<TaskRecord[]>;
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  requestTasksRef: RefObject<Map<string, string>>;
  agentEventSequencesRef: RefObject<Map<string, number>>;
  rememberTaskPaging: (taskId: string, paging: TaskPagingState) => void;
  taskPagingRef: RefObject<Map<string, TaskPagingState>>;
  claimTaskView: (taskId: string) => void;
  setActiveTaskId: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setActivities: Dispatch<SetStateAction<AgentActivity[]>>;
  setInput: (value: string) => void;
  initialDrafts: RefObject<TaskDrafts>;
  setRunningId: Dispatch<SetStateAction<string | undefined>>;
  currentRequest: RefObject<string | undefined>;
  requestStartedRef: RefObject<number | undefined>;
  setContextError: (message: string) => void;
};

export function useTaskPersistence({
  tasks,
  tasksRef,
  setTasks,
  requestTasksRef,
  agentEventSequencesRef,
  rememberTaskPaging,
  taskPagingRef,
  claimTaskView,
  setActiveTaskId,
  setMessages,
  setActivities,
  setInput,
  initialDrafts,
  setRunningId,
  currentRequest,
  requestStartedRef,
  setContextError,
}: TaskPersistenceBindings) {
  const [taskStorageReady, setTaskStorageReady] = useState(false);
  const hydratedTaskIdsRef = useRef(new Set(tasks.map((task) => task.id)));
  const persistedTaskRefsRef = useRef(new Map<string, TaskRecord>());
  const persistedTaskOrderRef = useRef("");
  useEffect(() => {
    if (!window.kcode?.state) {
      setTaskStorageReady(true);
      return;
    }
    let cancelled = false;
    void window.kcode.state
      .taskHeaders()
      .then(async (storedHeaders) => {
        if (cancelled) return;
        const runtimeStatuses = window.kcode.state.runtimeStatuses
          ? await window.kcode.state.runtimeStatuses().catch(() => [])
          : [];
        const runtimeByTask = new Map(
          runtimeStatuses.map((status) => [status.taskId, status] as const),
        );
        for (const runtime of runtimeStatuses) {
          if (runtime.turnStatus !== "in_progress") continue;
          requestTasksRef.current.set(runtime.requestId, runtime.taskId);
          agentEventSequencesRef.current.set(
            runtime.requestId,
            Math.max(
              agentEventSequencesRef.current.get(runtime.requestId) ?? 0,
              runtime.lastSequence,
            ),
          );
        }
        const restoreRuntimeStatus = (task: TaskRecord): TaskRecord => {
          const runtime = runtimeByTask.get(task.id);
          if (!runtime) return task;
          if (
            runtime.turnStatus === "in_progress" &&
            (runtime.status === "running" || runtime.status === "waiting")
          ) {
            taskRuntimeStore.ensureRunning(
              task.id,
              runtime.requestId,
              runtime.updatedAt,
            );
            return {
              ...task,
              runningId: runtime.requestId,
              runStatus: "running",
              runtimeStatus: runtime.status,
              startedAt: task.startedAt ?? runtime.updatedAt,
            };
          }
          if (
            (task.runningId && task.runningId !== runtime.requestId) ||
            (!task.runningId && task.updatedAt > runtime.updatedAt)
          )
            return task;
          return {
            ...task,
            runningId: undefined,
            runtimeStatus: runtime.status,
            runStatus:
              runtime.status === "waiting"
                ? "blocked"
                : runtime.status === "failed"
                  ? "failed"
                  : runtime.status === "interrupted"
                    ? "cancelled"
                    : "completed",
          };
        };
        if (Array.isArray(storedHeaders) && storedHeaders.length) {
          const headers = (storedHeaders as TaskRecord[]).map((task) =>
            restoreRuntimeStatus(
              normalizeStoredTask({ ...task, messages: [], activities: [] }),
            ),
          );
          const selectedHeader =
            headers.find(
              (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
            ) ?? headers[0];
          const hydrateTaskIds = new Set(
            runtimeStatuses
              .filter((status) => status.turnStatus === "in_progress")
              .map((status) => status.taskId),
          );
          if (selectedHeader) hydrateTaskIds.add(selectedHeader.id);
          const storedWindows = await Promise.all(
            [...hydrateTaskIds].map(async (taskId) => ({
              taskId,
              window: await window.kcode.state.loadTaskWindow(taskId),
            })),
          );
          if (cancelled) return;
          const hydratedTasks = new Map<string, TaskRecord>();
          for (const stored of storedWindows) {
            if (!stored.window) continue;
            rememberTaskPaging(stored.taskId, stored.window.paging);
            hydratedTasks.set(
              stored.taskId,
              restoreRuntimeStatus(
                normalizeStoredTask(stored.window.task as TaskRecord),
              ),
            );
          }
          const selectedTask = selectedHeader
            ? (hydratedTasks.get(selectedHeader.id) ?? selectedHeader)
            : undefined;
          const loaded = headers.map(
            (task) => hydratedTasks.get(task.id) ?? task,
          );
          hydratedTaskIdsRef.current = new Set(hydratedTasks.keys());
          persistedTaskRefsRef.current = new Map(hydratedTasks);
          persistedTaskOrderRef.current = JSON.stringify(
            loaded.map((task) => task.id),
          );
          claimTaskView(selectedTask?.id ?? "");
          setTasks(loaded);
          setActiveTaskId(selectedTask?.id ?? "");
          setMessages(selectedTask?.messages ?? []);
          setActivities(selectedTask?.activities ?? []);
          setInput(initialDrafts.current[selectedTask?.id ?? ""] ?? "");
          setRunningId(selectedTask?.runningId);
          currentRequest.current = selectedTask?.runningId;
          requestStartedRef.current = selectedTask?.startedAt;
        } else {
          const initial = tasksRef.current;
          hydratedTaskIdsRef.current = new Set(initial.map((task) => task.id));
          await Promise.all(
            initial.map((task) => window.kcode.state.saveTask(task.id, task)),
          );
          await window.kcode.state.saveTaskOrder(
            initial.map((task) => task.id),
          );
          persistedTaskRefsRef.current = new Map(
            initial.map((task) => [task.id, task]),
          );
          persistedTaskOrderRef.current = JSON.stringify(
            initial.map((task) => task.id),
          );
        }
        localStorage.removeItem("kcode.tasks");
        setTaskStorageReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setContextError(`数据库加载失败：${errorMessage(error)}`);
          setTaskStorageReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!taskStorageReady) return;
    if (!window.kcode?.state) {
      localStorage.setItem("kcode.tasks", JSON.stringify(tasks));
      return;
    }
    const order = JSON.stringify(tasks.map((task) => task.id));
    const dirty = tasks.filter(
      (task) =>
        hydratedTaskIdsRef.current.has(task.id) &&
        persistedTaskRefsRef.current.get(task.id) !== task,
    );
    const orderChanged = persistedTaskOrderRef.current !== order;
    if (!dirty.length && !orderChanged) return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        ...dirty.map((task) =>
          window.kcode.state.saveTask(task.id, task, {
            ...(taskPagingRef.current.has(task.id)
              ? { preserveUnloadedItems: true }
              : {}),
            ...taskSaveDiff(persistedTaskRefsRef.current.get(task.id), task),
          }),
        ),
        ...(orderChanged
          ? [window.kcode.state.saveTaskOrder(tasks.map((task) => task.id))]
          : []),
      ])
        .then(() => {
          dirty.forEach((task) =>
            persistedTaskRefsRef.current.set(task.id, task),
          );
          if (orderChanged) persistedTaskOrderRef.current = order;
        })
        .catch((error) =>
          setContextError(`数据库保存失败：${errorMessage(error)}`),
        );
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [tasks, taskStorageReady]);
  return { taskStorageReady, hydratedTaskIdsRef, persistedTaskRefsRef };
}
