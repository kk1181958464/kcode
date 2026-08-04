import type { RemoteTaskSnapshot } from "./remote-types";
import type { AgentActivity } from "./types";
import type { TaskRecord } from "./models";
import { visibleAssistantContent } from "./conversation-rendering";

function workspaceName(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "未设置工作区";
}

function safePath(value: string | undefined) {
  if (!value) return undefined;
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-3).join("/").slice(-180) || undefined;
}

function snapshotActivity(
  activity: AgentActivity,
): RemoteTaskSnapshot["activities"][number] {
  return {
    id: activity.id,
    requestId: activity.requestId,
    tool: activity.tool,
    status: activity.status,
    title: activity.title.slice(0, 240),
    narrative: activity.narrative?.slice(0, 2_000),
    textOffset: activity.textOffset,
    recoverable: activity.recoverable,
    liveStatus: activity.liveStatus?.slice(0, 500),
    planSteps: activity.planSteps
      ?.slice(0, 12)
      .map((step) => step.slice(0, 300)),
    planStep: activity.planStep,
    startedAt: activity.startedAt,
    completedAt: activity.completedAt,
    path: safePath(activity.path),
    additions: activity.additions,
    deletions: activity.deletions,
    exitCode: activity.exitCode,
    errorSummary: activity.errorSummary?.slice(0, 1_000),
  };
}

export function remoteTaskSnapshot(task: TaskRecord): RemoteTaskSnapshot {
  return {
    id: task.id,
    name: task.name.slice(0, 240),
    workspaceName: workspaceName(task.workspacePath),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    runningId: task.runningId,
    runStatus: task.runStatus,
    modelSelection: task.modelSelection,
    executorModelSelection: task.collaboration?.executorModelSelection,
    messages: task.messages.slice(-160).map((message) => ({
      id: message.id,
      role: message.role,
      content: (message.role === "assistant"
        ? visibleAssistantContent(message.content)
        : message.content
      ).slice(-120_000),
      error: message.error?.slice(0, 2_000),
      createdAt: message.createdAt,
      model: message.model,
      imageCount: message.images?.length || undefined,
      files: message.contextAttachments?.length
        ? message.contextAttachments.slice(0, 9).map((file) => ({
            name: file.name.slice(0, 240),
            size: file.size,
          }))
        : undefined,
    })),
    activities: task.activities.slice(-160).map(snapshotActivity),
    usage: task.usage
      ? {
          input: task.usage.input,
          output: task.usage.output,
          cached: task.usage.cached,
        }
      : undefined,
    durationMs: task.durationMs,
    archived: task.archived,
  };
}
