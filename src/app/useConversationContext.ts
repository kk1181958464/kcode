import {
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  resolveModelContextWindow,
  type ModelConfig,
  type ProviderConfig,
} from "../types";
import {
  acceptModelContextSummary,
  compactConversation,
  contextSummarySource,
  retainedCompactionContext,
} from "../context";
import { markContextCompacted } from "../context-window";
import { uid, type TaskRecord } from "../models";
import { errorMessage } from "../lib/format";
import {
  clearPromptTokenSnapshot,
  estimateRequestContextTokens,
  formatContextPercent,
} from "./app-utils";

type ConversationContextBindings = {
  activeTask: TaskRecord;
  activeTaskIdRef: RefObject<string>;
  models: { provider: ProviderConfig; model: ModelConfig }[];
  selectedContextWindow?: number;
  calibrationFactor: number;
  ensureFullTaskHistory: (task: TaskRecord) => Promise<TaskRecord>;
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  setContextError: (message: string) => void;
  flashContextToast: (message: string) => void;
};

export function summarySnapshot(task: TaskRecord) {
  if (!task.contextSummary) return task.summarySnapshots ?? [];
  return [
    {
      id: uid(),
      createdAt: Date.now(),
      summary: task.contextSummary,
      ledger: task.contextLedger ?? {
        goals: [],
        decisions: [],
        changedFiles: [],
        validations: [],
        failures: [],
        pending: [],
        connections: [],
      },
      compactedMessageCount: task.compactedMessageCount ?? 0,
      modelGenerated: task.summaryMeta?.modelGenerated ?? false,
      modelId: task.summaryMeta?.modelId,
      durationMs: task.summaryMeta?.durationMs,
      usage: task.summaryMeta?.usage,
    },
    ...(task.summarySnapshots ?? []),
  ].slice(0, 3);
}

export function useConversationContext({
  activeTask,
  activeTaskIdRef,
  models,
  selectedContextWindow,
  calibrationFactor,
  ensureFullTaskHistory,
  setTasks,
  setContextError,
  flashContextToast,
}: ConversationContextBindings) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summarizingTasks, setSummarizingTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const summaryBusy = Boolean(
    activeTask && summarizingTasks.has(activeTask.id),
  );

  async function summarizeConversation(
    task: TaskRecord,
    local: NonNullable<ReturnType<typeof compactConversation>>,
  ) {
    setSummarizingTasks((current) => new Set(current).add(task.id));
    try {
      return await improveSummaryWithModel(task, local);
    } finally {
      setSummarizingTasks((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  async function compactActiveConversation() {
    if (!activeTask) return;
    if (!selectedContextWindow) {
      setContextError("请先为当前模型配置上下文窗口");
      return;
    }
    let task: TaskRecord;
    try {
      task = await ensureFullTaskHistory(activeTask);
    } catch (error) {
      setContextError(`加载完整对话失败：${errorMessage(error)}`);
      return;
    }
    const compacted = compactConversation(task, selectedContextWindow, true);
    if (!compacted) {
      setContextError("当前对话较短，保留最近一轮后暂无可压缩内容");
      return;
    }
    const beforeTokens = estimateRequestContextTokens({
      messages: task.messages,
      compactedMessageCount: task.compactedMessageCount ?? 0,
      contextSummary: task.contextSummary,
      attachmentTokens: 0,
      outputReserve: 0,
      calibrationFactor,
      retainedContext: retainedCompactionContext(
        task.messages,
        task.compactedMessageCount ?? 0,
        selectedContextWindow,
      ),
    });
    const finalCompacted = await summarizeConversation(task, compacted);
    setTasks((all) =>
      all.map((item) => {
        if (item.id !== task.id) return item;
        const nextTask: TaskRecord = {
          ...item,
          ...finalCompacted,
          usage: clearPromptTokenSnapshot(item.usage),
          summaryMeta:
            "summaryMeta" in finalCompacted
              ? (finalCompacted.summaryMeta as TaskRecord["summaryMeta"])
              : { modelGenerated: false, durationMs: 0 },
          updatedAt: Date.now(),
        };
        return { ...nextTask, summarySnapshots: summarySnapshot(nextTask) };
      }),
    );
    const afterTokens = estimateRequestContextTokens({
      messages: task.messages,
      compactedMessageCount:
        finalCompacted.compactedMessageCount ?? compacted.compactedMessageCount,
      contextSummary: finalCompacted.contextSummary,
      attachmentTokens: 0,
      outputReserve: 0,
      calibrationFactor,
      retainedContext: retainedCompactionContext(
        task.messages,
        finalCompacted.compactedMessageCount ?? compacted.compactedMessageCount,
        selectedContextWindow,
      ),
    });
    setTasks((all) =>
      all.map((item) =>
        item.id === task.id
          ? {
              ...item,
              contextWindowState: markContextCompacted(
                item.contextWindowState,
                item.id,
                afterTokens,
                selectedContextWindow,
              ),
            }
          : item,
      ),
    );
    flashContextToast(
      `已压缩 ${finalCompacted.compactedMessageCount} 条较早消息：${formatContextPercent(beforeTokens, selectedContextWindow)} → ${formatContextPercent(afterTokens, selectedContextWindow)}，最近对话和关键状态继续保留`,
    );
  }

  async function improveSummaryWithModel(
    task: TaskRecord,
    local: NonNullable<ReturnType<typeof compactConversation>>,
  ) {
    if (!window.kcode?.chat.summarize) return local;
    const target = models.find(
      (item) => `${item.provider.id}|${item.model.id}` === task.modelSelection,
    );
    if (!target) return local;
    const contextWindow = resolveModelContextWindow(
      target.model.modelId,
      target.model.contextWindow,
    );
    try {
      const result = await window.kcode.chat.summarize({
        taskId: task.id,
        providerId: target.provider.id,
        modelId: target.model.modelId,
        source: contextSummarySource(
          task,
          local.compactedMessageCount,
          contextWindow,
        ),
        ledger: local.contextLedger,
      });
      const accepted = acceptModelContextSummary(local, result, contextWindow);
      if (!accepted) return local;
      return {
        ...local,
        contextSummary: accepted.summary,
        contextLedger: accepted.ledger,
        summaryMeta: {
          modelGenerated: true,
          modelId: result.modelId,
          durationMs: result.durationMs,
          usage: result.usage,
        },
      };
    } catch {
      return local;
    }
  }

  async function rebuildActiveSummary() {
    if (!activeTask || !selectedContextWindow) return;
    let task: TaskRecord;
    try {
      task = await ensureFullTaskHistory(activeTask);
    } catch (error) {
      setContextError(`加载完整对话失败：${errorMessage(error)}`);
      return;
    }
    const taskId = task.id;
    const local = compactConversation(
      {
        ...task,
        contextSummary: undefined,
        contextLedger: undefined,
        compactedMessageCount: 0,
      },
      selectedContextWindow,
      true,
    );
    if (!local) return setContextError("当前对话暂无足够内容用于生成摘要");
    const compacted = await summarizeConversation(task, local);
    setTasks((all) =>
      all.map((task) => {
        if (task.id !== taskId) return task;
        const nextTask: TaskRecord = {
          ...task,
          ...compacted,
          usage: clearPromptTokenSnapshot(task.usage),
          summaryMeta:
            "summaryMeta" in compacted
              ? (compacted.summaryMeta as TaskRecord["summaryMeta"])
              : { modelGenerated: false, durationMs: 0 },
          updatedAt: Date.now(),
        };
        return { ...nextTask, summarySnapshots: summarySnapshot(nextTask) };
      }),
    );
    if (activeTaskIdRef.current === taskId)
      setContextError(
        compacted === local
          ? "已使用本地规则重新生成摘要"
          : "已使用当前模型重新生成摘要和事实账本",
      );
  }

  function restoreFullContext() {
    if (!activeTask) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              contextSummary: undefined,
              contextLedger: undefined,
              compactedMessageCount: 0,
              usage: clearPromptTokenSnapshot(task.usage),
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    setSummaryOpen(false);
    flashContextToast("已恢复完整上下文；聊天记录没有被删除");
  }

  function restoreSummarySnapshot(
    snapshot: NonNullable<TaskRecord["summarySnapshots"]>[number],
  ) {
    if (!activeTask) return;
    setTasks((all) =>
      all.map((task) =>
        task.id === activeTask.id
          ? {
              ...task,
              contextSummary: snapshot.summary,
              contextLedger: snapshot.ledger,
              compactedMessageCount: snapshot.compactedMessageCount ?? 0,
              usage: clearPromptTokenSnapshot(task.usage),
              summaryMeta: {
                modelGenerated: snapshot.modelGenerated,
                modelId: snapshot.modelId,
                durationMs: snapshot.durationMs ?? 0,
                usage: snapshot.usage,
              },
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    flashContextToast("已恢复所选摘要版本");
  }

  return {
    summaryOpen,
    setSummaryOpen,
    summaryBusy,
    summarizingTasks,
    summarizeConversation,
    compactActiveConversation,
    rebuildActiveSummary,
    restoreFullContext,
    restoreSummarySnapshot,
  };
}
