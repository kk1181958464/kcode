import type { RemoteTaskSnapshot } from "./remote-types";
import type { AgentActivity } from "./types";
import type { TaskRecord } from "./models";
import { visibleAssistantContent } from "./conversation-rendering";
import { taskWorkspaceName } from "./task-workspace";

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
    toolCallId: activity.toolCallId,
    status: activity.status,
    title: activity.title.slice(0, 240),
    narrative: activity.narrative?.slice(0, 2_000),
    textOffset: activity.textOffset,
    subagentId: activity.subagentId,
    recoverable: activity.recoverable,
    liveStatus: activity.liveStatus?.slice(0, 500),
    planSteps: activity.planSteps
      ?.slice(0, 12)
      .map((step) => step.slice(0, 300)),
    planStatuses: activity.planStatuses?.slice(0, 12),
    planRequirements: activity.planRequirements
      ?.slice(0, 12)
      .map((requirements) => requirements.slice(0, 7)),
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

const REMOTE_MESSAGE_CONTENT_LIMIT = 120_000;

function snapshotMessage(message: TaskRecord["messages"][number]) {
  const visibleContent =
    message.role === "assistant"
      ? visibleAssistantContent(message.content)
      : message.content;
  const contentStart = Math.max(
    0,
    visibleContent.length - REMOTE_MESSAGE_CONTENT_LIMIT,
  );
  const content = visibleContent.slice(contentStart);
  const storedFinalResponseOffset = Number(message.finalResponseOffset);
  const visibleFinalResponseOffset = Number.isFinite(storedFinalResponseOffset)
    ? visibleAssistantContent(
        message.content.slice(
          0,
          Math.min(
            message.content.length,
            Math.max(0, Math.floor(storedFinalResponseOffset)),
          ),
        ),
      ).length
    : undefined;
  return {
    id: message.id,
    role: message.role,
    content,
    error: message.error?.slice(0, 2_000),
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    finalResponseOffset:
      visibleFinalResponseOffset === undefined
        ? undefined
        : Math.min(
            content.length,
            Math.max(0, visibleFinalResponseOffset - contentStart),
          ),
    finalResponseStartedAt: message.finalResponseStartedAt,
    finalResponseProcess: message.finalResponseProcess,
    completionResult: message.completionResult,
    model: message.model,
    imageCount: message.images?.length || undefined,
    files: message.contextAttachments?.length
      ? message.contextAttachments.slice(0, 9).map((file) => ({
          name: file.name.slice(0, 240),
          size: file.size,
        }))
      : undefined,
  };
}

export function remoteTaskSnapshot(task: TaskRecord): RemoteTaskSnapshot {
  return {
    id: task.id,
    name: task.name.slice(0, 240),
    workspaceName: taskWorkspaceName(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    runningId: task.runningId,
    runStatus: task.runStatus,
    runtimeStatus: task.runtimeStatus,
    modelSelection: task.modelSelection,
    executorModelSelection: task.collaboration?.executorModelSelection,
    messages: task.messages.slice(-160).map(snapshotMessage),
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
