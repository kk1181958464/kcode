import {
  useConversationContext,
  summarySnapshot,
} from "./useConversationContext";
import {
  estimateRequestContextTokens,
  outputTokenReserve,
  clearPromptTokenSnapshot,
  formatContextPercent,
} from "./app-utils";
import { resolveModelContextWindow } from "../types";
import {
  CONTEXT_AUTO_COMPACT_RATIO,
  CONTEXT_COMPACT_WARNING_RATIO,
  CONTEXT_FORCE_COMPACT_RATIO,
  compactConversation,
  estimateTextTokens,
  retainedCompactionContext,
} from "../context";
import { markContextCompacted } from "../context-window";
import { type TaskRecord } from "../models";
import { normalizeEffort, reasoningEffortsForModel } from "../lib/model-utils";
import type {
  ChatMessage,
  ContextFile,
  ProviderConfig,
  ReasoningEffort,
} from "../types";
import type { Dispatch, SetStateAction } from "react";
import type { ModelConfig } from "../types";
type PrepareChatContextOptions = {
  requestTask: TaskRecord;
  taskSelection: string;
  target: { provider: ProviderConfig; model: ModelConfig };
  nextMessages: ChatMessage[];
  user: ChatMessage;
  requestFiles: ContextFile[];
  defaultReasoningEffort: ReasoningEffort;
  tokenCalibration: Record<string, number>;
  summarizeConversation: ReturnType<
    typeof useConversationContext
  >["summarizeConversation"];
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
};

export async function prepareChatContext({
  requestTask,
  taskSelection,
  target,
  nextMessages,
  user,
  requestFiles,
  defaultReasoningEffort,
  tokenCalibration,
  summarizeConversation,
  setTasks,
}: PrepareChatContextOptions) {
  const taskId = requestTask.id;
  const requestContextWindow = resolveModelContextWindow(
    target.model.modelId,
    target.model.contextWindow,
  );
  const requestEfforts = reasoningEffortsForModel(target.model);
  const requestReasoningEffort = normalizeEffort(
    requestTask.reasoningEffort ?? defaultReasoningEffort,
    requestEfforts,
  );
  const requestTaskWithSelection = requestTask.modelSelection
    ? requestTask
    : { ...requestTask, modelSelection: taskSelection };
  let requestSummary = requestTask.contextSummary;
  let requestLedger = requestTask.contextLedger;
  let compactedCount = requestTask.compactedMessageCount ?? 0;
  let contextNotice = "";
  const attachmentTokens = requestFiles.reduce(
    (total, file) => total + estimateTextTokens(file.content),
    0,
  );
  const outputReserve = outputTokenReserve(
    requestContextWindow,
    requestEfforts.some((effort) => effort !== "auto"),
  );
  const requestCalibrationKey = `${target.provider.id}|${target.model.modelId}`;
  const requestCalibrationFactor = tokenCalibration[requestCalibrationKey] ?? 1;
  let retainedContext = retainedCompactionContext(
    nextMessages,
    compactedCount,
    requestContextWindow,
  );
  let rawEstimatedTokens = estimateRequestContextTokens({
    messages: nextMessages,
    compactedMessageCount: compactedCount,
    contextSummary: requestSummary,
    attachmentTokens,
    outputReserve,
    calibrationFactor: 1,
    retainedContext,
  });
  // Use the last round's prompt tokens as the observed floor, not the
  // accumulated billing total (usage.input) which grows every round and would
  // otherwise inflate the estimate and trigger premature compaction.
  const estimatedTokens = Math.max(
    requestTask.usage?.promptTokens ?? 0,
    Math.ceil(rawEstimatedTokens * requestCalibrationFactor),
  );
  const contextRatio = requestContextWindow
    ? estimatedTokens / requestContextWindow
    : 0;
  if (
    contextRatio >= CONTEXT_COMPACT_WARNING_RATIO &&
    contextRatio < CONTEXT_AUTO_COMPACT_RATIO
  )
    contextNotice = `预计下一次请求将占用 ${formatContextPercent(estimatedTokens, requestContextWindow)}，达到 ${Math.round(CONTEXT_AUTO_COMPACT_RATIO * 100)}% 时自动压缩`;
  if (
    requestContextWindow &&
    contextRatio >= CONTEXT_AUTO_COMPACT_RATIO &&
    requestTask
  ) {
    let compacted = compactConversation(
      { ...requestTask, messages: nextMessages },
      requestContextWindow,
      false,
      user.images?.length ? user.id : undefined,
    );
    if (contextRatio >= CONTEXT_FORCE_COMPACT_RATIO && !compacted)
      compacted = compactConversation(
        { ...requestTask, messages: nextMessages },
        requestContextWindow,
        true,
        user.images?.length ? user.id : undefined,
      );
    if (compacted) {
      // Recovery checkpoints are also compacted semantically. The runtime
      // ledger remains authoritative, so a resumed task does not need to
      // fall back to a lossy local outline just to start its next turn.
      const summarizeWithModel = Boolean(window.kcode?.chat.summarize);
      const finalCompacted = summarizeWithModel
        ? await summarizeConversation(
            { ...requestTaskWithSelection, messages: nextMessages },
            compacted,
          )
        : compacted;
      requestSummary = finalCompacted.contextSummary;
      requestLedger = finalCompacted.contextLedger;
      compactedCount = finalCompacted.compactedMessageCount ?? compactedCount;
      retainedContext = retainedCompactionContext(
        nextMessages,
        compactedCount,
        requestContextWindow,
      );
      rawEstimatedTokens = estimateRequestContextTokens({
        messages: nextMessages,
        compactedMessageCount: compactedCount,
        contextSummary: requestSummary,
        attachmentTokens,
        outputReserve,
        calibrationFactor: 1,
        retainedContext,
      });
      const afterEstimatedTokens = Math.ceil(
        rawEstimatedTokens * requestCalibrationFactor,
      );
      setTasks((all) =>
        all.map((task) => {
          if (task.id !== taskId) return task;
          const nextTask: TaskRecord = {
            ...task,
            ...finalCompacted,
            contextWindowState: markContextCompacted(
              task.contextWindowState,
              task.id,
              afterEstimatedTokens,
              requestContextWindow,
            ),
            usage: clearPromptTokenSnapshot(task.usage),
            summaryMeta:
              "summaryMeta" in finalCompacted
                ? (finalCompacted.summaryMeta as TaskRecord["summaryMeta"])
                : { modelGenerated: false, durationMs: 0 },
            updatedAt: Date.now(),
          };
          return { ...nextTask, summarySnapshots: summarySnapshot(nextTask) };
        }),
      );
      contextNotice = `上下文 ${formatContextPercent(estimatedTokens, requestContextWindow)} → ${formatContextPercent(afterEstimatedTokens, requestContextWindow)}，已自动压缩 ${compactedCount} 条较早消息`;
    }
  }
  const currentUserIndex = nextMessages.findIndex(
    (message) => message.id === user.id,
  );
  if (
    user.images?.length &&
    currentUserIndex >= 0 &&
    currentUserIndex < compactedCount
  ) {
    // A stale compactedMessageCount must never hide the image attached to
    // the request being sent. Reopen the request window at that message and
    // rebuild the retained checkpoint alongside it.
    compactedCount = currentUserIndex;
    retainedContext = retainedCompactionContext(
      nextMessages,
      compactedCount,
      requestContextWindow,
    );
  }
  return {
    requestContextWindow,
    requestReasoningEffort,
    requestSummary,
    requestLedger,
    compactedCount,
    retainedContext,
    rawEstimatedTokens,
    requestCalibrationKey,
    contextNotice,
  };
}
