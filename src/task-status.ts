import type { AgentActivity, ChatMessage } from "./types";

export type TaskRunStatus =
  "idle" | "running" | "completed" | "failed" | "cancelled" | "paused";

export function isTaskViewCurrent(
  activeTaskId: string,
  displayedTaskId: string,
  expectedTaskId: string,
) {
  return (
    Boolean(expectedTaskId) &&
    activeTaskId === expectedTaskId &&
    displayedTaskId === expectedTaskId
  );
}

export function recoverTaskRunStatus(task: {
  runningId?: string;
  runStatus?: TaskRunStatus;
  messages: ChatMessage[];
}): TaskRunStatus {
  if (task.runningId || task.runStatus === "running") return "paused";
  if (task.runStatus) return task.runStatus;
  const latestAssistant = [...task.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        Boolean(message.content || message.error),
    );
  if (
    latestAssistant?.error ||
    latestAssistant?.content.startsWith("请求失败：")
  )
    return "failed";
  if (latestAssistant) return "completed";
  return "idle";
}

export function recoverInterruptedActivities(
  activities: AgentActivity[],
  completedAt: number,
) {
  return activities.map((activity) =>
    activity.status === "running" || activity.status === "waiting"
      ? {
          ...activity,
          status: "failed" as const,
          completedAt,
          errorSummary:
            activity.errorSummary ?? "应用在该操作完成前中断，请重新执行。",
        }
      : activity,
  );
}
