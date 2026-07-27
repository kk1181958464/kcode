import {
  recoverOrphanedFailure,
  recoverInterruptedActivities,
  recoverTaskRunStatus,
} from "../task-status";
import type { TaskRecord } from "../models";

export function normalizeStoredTask(task: TaskRecord): TaskRecord {
  const runStatus = recoverTaskRunStatus(task);
  return {
    ...task,
    messages: recoverOrphanedFailure(task.messages, runStatus, task.updatedAt),
    runningId: undefined,
    startedAt: undefined,
    runStatus,
    activities: recoverInterruptedActivities(task.activities, task.updatedAt),
  };
}

export function storedTasks(): TaskRecord[] {
  try {
    return (
      JSON.parse(localStorage.getItem("kcode.tasks") || "[]") as TaskRecord[]
    ).map(normalizeStoredTask);
  } catch {
    return [];
  }
}

export function storedActiveTask() {
  const all = storedTasks();
  return (
    all.find(
      (task) => task.id === localStorage.getItem("kcode.activeTaskId"),
    ) ?? all[0]
  );
}

export function storedTokenCalibration(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("kcode.tokenCalibration") || "{}");
  } catch {
    return {};
  }
}
