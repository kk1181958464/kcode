import type { AgentActivity, AgentCompletionResult, ChatMessage } from "./types";
import { classifyRuntimeError } from "./runtime-errors";

export type TaskRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "blocked";

export function nextQueuedMessageId(task: {
  runningId?: string;
  runStatus?: TaskRunStatus;
  messages: ChatMessage[];
}) {
  if (task.runningId || task.runStatus === "running") return undefined;
  return task.messages.find(
    (message) =>
      message.role === "user" &&
      Boolean((message as ChatMessage & { queued?: boolean }).queued),
  )?.id;
}

export function finishTaskRequest(
  currentRequestId: string | undefined,
  finishedRequestId: string,
  finishedStatus: Exclude<TaskRunStatus, "idle" | "running">,
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
  if (task.runStatus === "cancelled") return "cancelled";
  const latestAssistant = [...task.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        Boolean(
          message.content || message.error || message.completionResult,
        ),
    );
  if (latestAssistant?.completionResult?.kind === "blocked") return "blocked";
  if (latestAssistant?.completionResult?.kind === "incomplete") return "paused";
  if (latestAssistant?.error) {
    return isRetryableDisconnectError(latestAssistant.error)
      ? "paused"
      : "failed";
  }
  if (task.runStatus) return task.runStatus;
  if (latestAssistant) return "completed";
  return "idle";
}

function isLaunchFailure(error: string) {
  return /模型请求未能启动|启动阶段中断/.test(error);
}

export function isRetryableDisconnectError(error: string) {
  return (
    !isLaunchFailure(error) && classifyRuntimeError(error).retryable
  );
}

const emptyDisconnectResult = (notice: string): AgentCompletionResult => ({
  kind: "incomplete",
  operations: [],
  missingOperations: [],
  toolCalls: 0,
  successfulTools: 0,
  failedTools: 0,
  changedFiles: [],
  additions: 0,
  deletions: 0,
  notice,
});

/** Persist a retryable disconnect as an incomplete pause, not a hard failure. */
export function recoverRetryableDisconnectMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.error || message.completionResult)
      return message;
    if (!isRetryableDisconnectError(message.error)) return message;
    return {
      ...message,
      error: undefined,
      completionResult: emptyDisconnectResult(message.error),
    };
  });
}

export function recoverOrphanedFailure(
  messages: ChatMessage[],
  status: TaskRunStatus,
  createdAt: number,
) {
  const latest = messages.at(-1) as
    (ChatMessage & { queued?: boolean }) | undefined;
  if (status !== "failed" || latest?.role !== "user" || latest.queued)
    return messages;
  return [
    ...messages,
    {
      id: `assistant:recovered-failure:${latest.id}`,
      role: "assistant" as const,
      content: "",
      createdAt,
      error:
        "生成失败：上一次模型请求在启动阶段中断，未返回内容。请重试或切换模型/供应商。",
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
