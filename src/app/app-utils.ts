import {
  AGENT_STATIC_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
} from "../context";
import { type TaskRecord } from "../models";
import type { ChatMessage, TaskWindow } from "../types";

export function estimateRequestContextTokens({
  messages,
  compactedMessageCount,
  contextSummary,
  attachmentTokens,
  outputReserve,
  calibrationFactor,
  retainedContext,
}: {
  messages: ChatMessage[];
  compactedMessageCount: number;
  contextSummary?: string;
  attachmentTokens: number;
  outputReserve: number;
  calibrationFactor: number;
  retainedContext?: string;
}) {
  return Math.ceil(
    (AGENT_STATIC_TOKENS +
      attachmentTokens +
      outputReserve +
      estimateMessageTokens(messages.slice(compactedMessageCount)) +
      estimateTextTokens(contextSummary ?? "") +
      estimateTextTokens(retainedContext ?? "")) *
      calibrationFactor,
  );
}

export function outputTokenReserve(
  contextWindow: number | undefined,
  reasoning: boolean,
) {
  if (!contextWindow) return 8_000;
  return Math.max(8_000, Math.floor(contextWindow * (reasoning ? 0.18 : 0.12)));
}

export function clearPromptTokenSnapshot(usage: TaskRecord["usage"]) {
  if (!usage) return usage;
  const { promptTokens: _promptTokens, ...rest } = usage;
  return rest;
}

// Restore the saved view, falling back to the workspace's original default.
// Tasks without a workspace cannot restore the editor.
export function resolveWorkspaceView(task: TaskRecord): "chat" | "editor" {
  const saved = task.workspaceView;
  const fallback = task.remoteWorkspace ? "editor" : "chat";
  const desired = saved ?? fallback;
  if (
    desired === "editor" &&
    !task.workspacePath &&
    !task.localWorkspacePath &&
    !task.remoteWorkspace
  )
    return "chat";
  return desired;
}

export function formatContextPercent(tokens: number, contextWindow?: number) {
  if (!contextWindow) return "未配置";
  return `${Math.min(100, Math.round((tokens / contextWindow) * 100))}%`;
}

export function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
export type TaskPagingState = TaskWindow["paging"];
