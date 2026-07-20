import type { AgentActivity, ChatMessage } from "./types";

export type TaskRunStatus =
  "idle" | "running" | "completed" | "failed" | "cancelled" | "paused";

export function finishTaskRequest(
  currentRequestId: string | undefined,
  finishedRequestId: string,
  finishedStatus: Exclude<TaskRunStatus, "idle" | "running" | "paused">,
) {
  const hasNewerRequest = Boolean(
    currentRequestId && currentRequestId !== finishedRequestId,
  );
  return hasNewerRequest
    ? { runningId: currentRequestId, runStatus: "running" as const }
    : { runningId: undefined, runStatus: finishedStatus };
}

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

export function recoverOrphanedFailure(
  messages: ChatMessage[],
  status: TaskRunStatus,
  createdAt: number,
) {
  const latest = messages.at(-1) as (ChatMessage & { queued?: boolean }) | undefined;
  if (status !== "failed" || latest?.role !== "user" || latest.queued)
    return messages;
  return [
    ...messages,
    {
      id: `assistant:recovered-failure:${latest.id}`,
      role: "assistant" as const,
      content: "",
      createdAt,
      error: "生成失败：上一次模型请求在启动阶段中断，未返回内容。请重试或切换模型/供应商。",
    },
  ];
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
