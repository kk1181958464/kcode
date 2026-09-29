import { useConversationContext } from "./useConversationContext";
import { useAgentStream } from "./useAgentStream";
import { useEffect, useRef } from "react";
import { resolveModelContextWindow } from "../types";
import type { SshRemoteState } from "../ssh-remote-types";
import {
  isSshRemoteCredentialsRequired,
  restoreSshRemoteConnection,
} from "../ssh-remote-recovery";
import { attachSshWorkspace, localWorkspacePath } from "../task-workspace";
import {
  assistantRequestId,
  buildInterruptedRunRecoveryContext,
  recoveryEvidenceFromActivities,
  recoveryPlanFromCompletionResult,
  recoveryPlanFromActivities,
} from "../interrupted-run-context";
import { uid, type QueuedChatMessage, type TaskRecord } from "../models";
import { taskRuntimeStore } from "../task-runtime-store";
import {
  effortLabels,
  normalizeEffort,
  reasoningEffortsForModel,
} from "../lib/model-utils";
import { errorMessage } from "../lib/format";
import { consumeStreamingText } from "../streaming-text-store";
import { prependUniqueItems } from "../task-history-paging";
import {
  designElementChipLabel,
  type DesignElementContext,
} from "../design-mode";
import { isTaskViewCurrent } from "../task-status";
import { completionResultFromActivities } from "../completion-summary";
import type {
  AgentActivity,
  ChatMessage,
  ContextFile,
  ProviderConfig,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  ImageAttachment,
} from "../types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ModelConfig } from "../types";
import { prepareChatContext } from "./prepare-chat-context";
import { buildChatHistory } from "./chat-request";
type ChatSubmissionBindings = {
  session: {
    activeTask: TaskRecord;
    activeTaskIdRef: RefObject<string>;
    displayedTaskIdRef: RefObject<string>;
    tasksRef: RefObject<TaskRecord[]>;
    messages: ChatMessage[];
    activities: AgentActivity[];
    runningId: string | undefined;
    setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setActivities: Dispatch<SetStateAction<AgentActivity[]>>;
    setRunningId: Dispatch<SetStateAction<string | undefined>>;
    currentRequest: RefObject<string | undefined>;
    requestTasksRef: RefObject<Map<string, string>>;
    requestStartedRef: RefObject<number | undefined>;
    ensureFullTaskHistory: (task: TaskRecord) => Promise<TaskRecord>;
    taskHistoryIsPartial: (taskId: string) => boolean;
  };
  composer: {
    readComposerValue: () => string;
    attachedFiles: ContextFile[];
    attachedImages: ImageAttachment[];
    designElements: DesignElementContext[];
    contextByMessageRef: RefObject<Map<string, ContextFile[]>>;
    designByMessageRef: RefObject<Map<string, DesignElementContext[]>>;
    consumeDraft: (taskId: string) => void;
    setInput: (value: string) => void;
  };
  configuration: {
    models: { provider: ProviderConfig; model: ModelConfig }[];
    selected: string;
    defaultReasoningEffort: ReasoningEffort;
    permissionMode: PermissionMode;
    permissionPolicy: PermissionPolicy;
    tokenCalibration: Record<string, number>;
  };
  context: {
    summarizingTasks: ReadonlySet<string>;
    summarizeConversation: ReturnType<
      typeof useConversationContext
    >["summarizeConversation"];
  };
  stream: {
    textFlushTimerRef: RefObject<number | undefined>;
    flushPendingText: ReturnType<typeof useAgentStream>["flushPendingText"];
    flushRemoteStreamSync: ReturnType<
      typeof useAgentStream
    >["flushRemoteStreamSync"];
    clearPendingReasoning: ReturnType<
      typeof useAgentStream
    >["clearPendingReasoning"];
    clearStreamingProgress: ReturnType<
      typeof useAgentStream
    >["clearStreamingProgress"];
  };
  view: {
    setAssignFolderForTask: Dispatch<SetStateAction<TaskRecord | null>>;
    attachConnectedSshState: (taskId: string, state: SshRemoteState) => void;
    setSshRemoteState: Dispatch<SetStateAction<SshRemoteState | undefined>>;
    setContextError: (message: string) => void;
    flashContextToast: (message: string) => void;
    autoFollowRef: RefObject<boolean>;
    scrollAfterSendRef: RefObject<boolean>;
    setShowScrollToBottom: Dispatch<SetStateAction<boolean>>;
    setUsedContextCount: Dispatch<SetStateAction<number>>;
    setUsage: Dispatch<SetStateAction<NonNullable<TaskRecord["usage"]>>>;
    setUsageResolved: Dispatch<SetStateAction<boolean>>;
    setDurationMs: Dispatch<SetStateAction<number>>;
  };
};

export function useChatSubmission({
  session,
  composer,
  configuration,
  context,
  stream,
  view,
}: ChatSubmissionBindings) {
  const {
    activeTask,
    activeTaskIdRef,
    displayedTaskIdRef,
    tasksRef,
    messages,
    activities,
    runningId,
    setTasks,
    setMessages,
    setActivities,
    setRunningId,
    currentRequest,
    requestTasksRef,
    requestStartedRef,
    ensureFullTaskHistory,
    taskHistoryIsPartial,
  } = session;
  const {
    readComposerValue,
    attachedFiles,
    attachedImages,
    designElements,
    contextByMessageRef,
    designByMessageRef,
    consumeDraft,
    setInput,
  } = composer;
  const {
    models,
    selected,
    defaultReasoningEffort,
    permissionMode,
    permissionPolicy,
    tokenCalibration,
  } = configuration;
  const { summarizingTasks, summarizeConversation } = context;
  const {
    textFlushTimerRef,
    flushPendingText,
    flushRemoteStreamSync,
    clearPendingReasoning,
    clearStreamingProgress,
  } = stream;
  const {
    setAssignFolderForTask,
    attachConnectedSshState,
    setSshRemoteState,
    setContextError,
    flashContextToast,
    autoFollowRef,
    scrollAfterSendRef,
    setShowScrollToBottom,
    setUsedContextCount,
    setUsage,
    setUsageResolved,
    setDurationMs,
  } = view;
  const sendingTasksRef = useRef(new Set<string>());
  const previewTimerRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (previewTimerRef.current)
        window.clearInterval(previewTimerRef.current);
    },
    [],
  );

  async function send(
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) {
    const lockTaskId = queuedTaskId ?? activeTask?.id ?? "";
    // Synchronous re-entrancy guard: the runningId/runStatus checks below
    // only see state written after several awaits, so a fast second click
    // (or Enter) would slip through before the first call locks the task.
    if (lockTaskId && sendingTasksRef.current.has(lockTaskId)) return;
    if (lockTaskId) sendingTasksRef.current.add(lockTaskId);
    try {
      await sendInner(override, queuedMessageId, queuedTaskId);
    } finally {
      if (lockTaskId) sendingTasksRef.current.delete(lockTaskId);
    }
  }

  async function sendInner(
    override?: string,
    queuedMessageId?: string,
    queuedTaskId?: string,
  ) {
    let requestTask = queuedTaskId
      ? tasksRef.current.find((task) => task.id === queuedTaskId)
      : activeTask;
    const taskId = requestTask?.id ?? "";
    const taskIsCurrent = () =>
      isTaskViewCurrent(
        activeTaskIdRef.current,
        displayedTaskIdRef.current,
        taskId,
      );
    if (requestTask && taskHistoryIsPartial(requestTask.id)) {
      try {
        requestTask = await ensureFullTaskHistory(requestTask);
      } catch (error) {
        if (taskIsCurrent())
          setContextError(`加载完整对话失败：${errorMessage(error)}`);
        return;
      }
    }
    const taskMessages = requestTask
      ? taskIsCurrent()
        ? prependUniqueItems(requestTask.messages, messages)
        : requestTask.messages
      : [];
    const taskSelection = requestTask?.modelSelection || selected;
    const taskSummaryBusy = Boolean(
      requestTask && summarizingTasks.has(requestTask.id),
    );
    let text = queuedMessageId ? "" : (override ?? readComposerValue()).trim();
    const target = models.find(
      (x) => `${x.provider.id}|${x.model.id}` === taskSelection,
    );
    if (
      (!text && !attachedImages.length && !queuedMessageId) ||
      !target ||
      !requestTask ||
      requestTask.runningId ||
      requestTask.runStatus === "running" ||
      taskSummaryBusy
    )
      return;
    const requestRemoteWorkspace = requestTask.remoteWorkspace;
    if (
      !requestTask.workspacePath &&
      !localWorkspacePath(requestTask) &&
      !requestRemoteWorkspace
    ) {
      setAssignFolderForTask(requestTask);
      return;
    }
    if (requestRemoteWorkspace && window.kcode?.sshRemote) {
      try {
        const connected = await restoreSshRemoteConnection(
          window.kcode.sshRemote,
          taskId,
          requestRemoteWorkspace,
        );
        if (connected.profile && connected.cachePath) {
          requestTask = attachSshWorkspace(requestTask, {
            profile: connected.profile,
            cachePath: connected.cachePath,
          });
          attachConnectedSshState(taskId, connected);
        }
        if (taskIsCurrent()) setSshRemoteState(connected);
      } catch (error) {
        if (taskIsCurrent()) {
          const credentialsRequired = isSshRemoteCredentialsRequired(error);
          const message = credentialsRequired
            ? "SSH Remote 暂未连接；消息仍会发送，远程操作时将使用本轮提供的凭据重连。"
            : `SSH Remote 暂未连接：${errorMessage(error)}；消息仍会发送。`;
          const disconnected = await window.kcode.sshRemote
            .state(taskId, requestRemoteWorkspace.id)
            .catch(() => undefined);
          setSshRemoteState({
            taskId,
            connected: false,
            connecting: false,
            ...disconnected,
            profile: disconnected?.profile ?? requestRemoteWorkspace,
            cachePath: disconnected?.cachePath ?? requestTask.workspacePath,
            error: errorMessage(error),
          });
          setContextError("");
          flashContextToast(message);
        }
      }
    }
    const requestedCollaboration = requestTask.collaboration;
    let collaboration:
      | {
          mode: "planner-executor";
          executor: {
            providerId: string;
            modelId: string;
            displayName: string;
            reasoningEffort: ReturnType<typeof normalizeEffort>;
            contextWindow?: number;
          };
        }
      | { mode: "plan-confirm" }
      | undefined;
    if (requestedCollaboration?.mode === "plan-confirm") {
      collaboration = { mode: "plan-confirm" };
    } else if (requestedCollaboration?.mode === "planner-executor") {
      const executorTarget = models.find(
        (item) =>
          `${item.provider.id}|${item.model.id}` ===
          requestedCollaboration.executorModelSelection,
      );
      if (
        !executorTarget ||
        !executorTarget.provider.hasApiKey ||
        requestedCollaboration.executorModelSelection === taskSelection
      ) {
        setContextError("协作模式的执行模型不可用，请重新选择执行模型");
        return;
      }
      collaboration = {
        mode: "planner-executor",
        executor: {
          providerId: executorTarget.provider.id,
          modelId: executorTarget.model.modelId,
          displayName: executorTarget.model.displayName,
          reasoningEffort: normalizeEffort(
            requestedCollaboration.executorReasoningEffort ?? "auto",
            reasoningEffortsForModel(executorTarget.model),
          ),
          contextWindow: resolveModelContextWindow(
            executorTarget.model.modelId,
            executorTarget.model.contextWindow,
          ),
        },
      };
    }
    if (!queuedMessageId && !taskIsCurrent()) {
      setContextError("任务切换尚未完成，请重新发送");
      return;
    }
    if (requestTask.name === "新对话") {
      const title = text.replace(/\s+/g, " ").slice(0, 28) || "新对话";
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? { ...task, name: title, updatedAt: Date.now() }
            : task,
        ),
      );
    }
    const queuedIndex = queuedMessageId
      ? taskMessages.findIndex(
          (message) =>
            message.id === queuedMessageId &&
            (message as QueuedChatMessage).queued,
        )
      : -1;
    if (queuedMessageId && queuedIndex < 0) return;
    const queuedMessage =
      queuedIndex >= 0
        ? (taskMessages[queuedIndex] as QueuedChatMessage)
        : undefined;
    if (queuedMessage) text = queuedMessage.content;
    const retrying = override !== undefined && !queuedMessage;
    const sourceMessages =
      queuedIndex >= 0 ? taskMessages.slice(0, queuedIndex + 1) : taskMessages;
    const latestAssistant = [...sourceMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const resumingInterruptedRun = Boolean(
      latestAssistant &&
      (latestAssistant.error ||
        latestAssistant.completionResult?.kind === "incomplete" ||
        latestAssistant.completionResult?.kind === "blocked" ||
        ["cancelled", "paused", "failed"].includes(
          requestTask.runStatus ?? "",
        )),
    );
    const interruptedRequestId = assistantRequestId(latestAssistant);
    const interruptedRecoveryPlan = resumingInterruptedRun
      ? (recoveryPlanFromActivities(
          requestTask.activities,
          interruptedRequestId,
        ) ??
        recoveryPlanFromCompletionResult(latestAssistant?.completionResult))
      : undefined;
    const interruptedRecoveryEvidence = resumingInterruptedRun
      ? recoveryEvidenceFromActivities(
          requestTask.activities,
          interruptedRequestId,
          latestAssistant?.completionResult,
        )
      : undefined;
    const interruptedRecoveryContext = resumingInterruptedRun
      ? buildInterruptedRunRecoveryContext(
          requestTask.activities,
          interruptedRequestId,
        )
      : undefined;
    const cleanMessages = sourceMessages.filter((message) => {
      if (message.role !== "assistant") return true;
      // Keep useful partial output from interrupted rounds in the next request.
      // Only discard assistant placeholders that contain no model output.
      return !(message.error && !message.content.trim());
    });
    const user: ChatMessage = queuedMessage
      ? {
          id: queuedMessage.id,
          role: queuedMessage.role,
          content: queuedMessage.content,
          createdAt: queuedMessage.createdAt,
          images: queuedMessage.images,
          contextAttachments: queuedMessage.contextAttachments,
          designAttachments: queuedMessage.designAttachments,
        }
      : retrying && cleanMessages.at(-1)?.role === "user"
        ? (cleanMessages.at(-1) as ChatMessage)
        : {
            id: uid(),
            role: "user",
            content:
              text ||
              (designElements.length
                ? "请根据选中的设计元素修改界面"
                : "请分析这些图片"),
            createdAt: Date.now(),
            images: attachedImages,
            contextAttachments: attachedFiles.length
              ? attachedFiles.map(({ name, size }) => ({ name, size }))
              : undefined,
            designAttachments: designElements.length
              ? designElements.map((item) => ({
                  id: item.id,
                  label: designElementChipLabel(item),
                  tagName: item.tagName,
                  cssSelector: item.cssSelector,
                }))
              : undefined,
          };
    const nextMessages = queuedMessage
      ? cleanMessages.map((message) =>
          message.id === user.id ? user : message,
        )
      : retrying && cleanMessages.at(-1)?.role === "user"
        ? cleanMessages
        : [...cleanMessages, user];
    const visibleMessages = queuedMessage
      ? taskMessages.map((message) => (message.id === user.id ? user : message))
      : retrying
        ? taskMessages
        : [...taskMessages, user];
    const requestFiles = queuedMessage
      ? (contextByMessageRef.current.get(user.id) ?? [])
      : attachedFiles;
    if (!retrying && !queuedMessage) {
      contextByMessageRef.current.set(user.id, requestFiles);
      designByMessageRef.current.set(user.id, designElements);
    }
    const {
      requestContextWindow,
      requestReasoningEffort,
      requestSummary,
      requestLedger,
      compactedCount,
      retainedContext,
      rawEstimatedTokens,
      requestCalibrationKey,
      contextNotice,
    } = await prepareChatContext({
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
    });
    const history = buildChatHistory({
      nextMessages,
      compactedCount,
      contextByMessage: contextByMessageRef.current,
      designByMessage: designByMessageRef.current,
      resumingInterruptedRun,
      currentUserId: user.id,
      requestSummary,
      requestLedger,
      retainedContext,
    });
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify(history),
    ).byteLength;
    if (payloadBytes > 24 * 1024 * 1024) {
      if (taskIsCurrent())
        setContextError(
          `请求内容 ${(payloadBytes / 1024 / 1024).toFixed(1)} MB，超过 24 MB 限制；请压缩上下文或减少图片/附件`,
        );
      return;
    }
    const requestStartedAt = Date.now();
    if (taskIsCurrent()) {
      autoFollowRef.current = true;
      scrollAfterSendRef.current = true;
      setShowScrollToBottom(false);
      requestStartedRef.current = requestStartedAt;
      setUsedContextCount(requestFiles.length);
      if (!queuedMessage) {
        consumeDraft(taskId);
      }
      if (contextNotice) flashContextToast(contextNotice);
      setMessages(visibleMessages);
      if (!queuedMessage) setInput("");
      setUsage({ input: 0, output: 0, cached: 0 });
      setUsageResolved(false);
      setDurationMs(0);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? { ...task, usedContextCount: requestFiles.length }
          : task,
      ),
    );
    if (!window.kcode) {
      if (!taskIsCurrent()) return;
      const id = `preview:${uid()}`;
      const response = `我已经检查了当前项目${requestFiles.length ? `和 **${requestFiles.length} 个上下文文件**` : ""}。当前使用${effortLabels[requestReasoningEffort]}推理强度，下一步建议优先完成：\n\n1. 接入工作区文件读取与代码搜索\n2. 建立工具调用的权限确认流程\n3. 在任务右侧展示实时执行进度\n\n\`\`\`ts\nconst result = await agent.run({\n  workspace: "D:/project/kcode",\n  model: "${target.model.modelId}",\n});\n\`\`\`\n\n> 当前模型通道正常，桌面端可以继续接入 Agent 工具循环。`;
      const chunks = response.match(/[\s\S]{1,12}/g) ?? [response];
      currentRequest.current = id;
      taskRuntimeStore.start(taskId, id, requestStartedAt);
      setRunningId(id);
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                runningId: id,
                runStatus: "running",
                startedAt: requestStartedAt,
                updatedAt: Date.now(),
              }
            : task,
        ),
      );
      setMessages([
        ...visibleMessages,
        {
          id: `assistant:${id}`,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          model: target.model.displayName,
        },
      ]);
      let index = 0;
      previewTimerRef.current = window.setInterval(() => {
        const chunk = chunks[index++];
        if (chunk)
          setMessages((all) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? { ...message, content: message.content + chunk }
                : message,
            ),
          );
        if (index >= chunks.length) {
          if (previewTimerRef.current)
            window.clearInterval(previewTimerRef.current);
          previewTimerRef.current = undefined;
          const completedAt = Date.now();
          setMessages((all) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? { ...message, completedAt }
                : message,
            ),
          );
          currentRequest.current = undefined;
          taskRuntimeStore.finish(taskId, id);
          setRunningId(undefined);
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    runningId: undefined,
                    runStatus: "completed",
                    updatedAt: completedAt,
                  }
                : task,
            ),
          );
          setUsage({ input: 312, output: 168, cached: 0 });
          setUsageResolved(true);
          if (requestStartedRef.current)
            setDurationMs(completedAt - requestStartedRef.current);
        }
      }, 45);
      return;
    }
    const id = uid();
    requestTasksRef.current.set(id, taskId);
    taskRuntimeStore.start(taskId, id, requestStartedAt);
    const assistantMessage: ChatMessage = {
      id: `assistant:${id}`,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      model: target.model.displayName,
    };
    const insertAssistant = (all: ChatMessage[]) => {
      if (!queuedMessage) return [...all, assistantMessage];
      const userIndex = all.findIndex((message) => message.id === user.id);
      if (userIndex < 0) return [...all, assistantMessage];
      return [
        ...all.slice(0, userIndex + 1),
        assistantMessage,
        ...all.slice(userIndex + 1),
      ];
    };
    const stillActive = isTaskViewCurrent(
      activeTaskIdRef.current,
      displayedTaskIdRef.current,
      taskId,
    );
    if (stillActive) {
      currentRequest.current = id;
      setRunningId(id);
      setMessages(insertAssistant);
    }
    setTasks((all) =>
      all.map((task) =>
        task.id === taskId
          ? {
              ...task,
              messages: insertAssistant(visibleMessages),
              runningId: id,
              runStatus: "running",
              startedAt: requestStartedAt,
              pendingTokenEstimate: rawEstimatedTokens,
              pendingCalibrationKey: requestCalibrationKey,
              updatedAt: Date.now(),
            }
          : task,
      ),
    );
    try {
      await window.kcode.chat.start({
        requestId: id,
        taskId,
        currentMessageId: user.id,
        connectionSessionId: requestTask.remoteWorkspace ? taskId : undefined,
        providerId: target.provider.id,
        modelId: target.model.modelId,
        messages: history,
        reasoningEffort: requestReasoningEffort,
        permissionMode,
        permissionPolicy,
        workspacePath:
          requestTask.workspacePath || localWorkspacePath(requestTask) || "",
        localWorkspacePath: localWorkspacePath(requestTask),
        remoteWorkspace: requestTask.remoteWorkspace,
        contextWindow: requestContextWindow,
        agentRole:
          collaboration?.mode === "planner-executor" ? "planner" : undefined,
        collaboration,
        recoveryContext: interruptedRecoveryContext,
        recoveryPlan: interruptedRecoveryPlan,
        recoveryEvidence: interruptedRecoveryEvidence,
      });
    } catch (error) {
      taskRuntimeStore.finish(taskId, id);
      const detail = errorMessage(error);
      const failure = detail
        ? `生成失败：模型请求未能启动。${detail}`
        : "生成失败：模型请求未能启动，请稍后重试或切换模型/供应商。";
      const completedAt = Date.now();
      const markFailed = (all: ChatMessage[]) =>
        all.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, error: failure, completedAt }
            : message,
        );
      const elapsed = completedAt - requestStartedAt;
      if (taskIsCurrent()) {
        setMessages(markFailed);
        currentRequest.current = undefined;
        setRunningId(undefined);
        setDurationMs(elapsed);
        setUsageResolved(true);
      }
      setTasks((all) =>
        all.map((task) =>
          task.id === taskId
            ? {
                ...task,
                messages: markFailed(task.messages),
                runningId: undefined,
                runStatus: "failed",
                durationMs: elapsed,
                usageResolved: true,
                pendingTokenEstimate: undefined,
                pendingCalibrationKey: undefined,
                updatedAt: completedAt,
              }
            : task,
        ),
      );
      requestTasksRef.current.delete(id);
      if (taskIsCurrent()) scrollAfterSendRef.current = true;
      return;
    }
  }

  async function cancel() {
    if (runningId) {
      const requestId = runningId;
      if (window.kcode) await window.kcode.chat.cancel(requestId);
      if (textFlushTimerRef.current) {
        window.clearTimeout(textFlushTimerRef.current);
        textFlushTimerRef.current = undefined;
      }
      flushPendingText(true);
      flushRemoteStreamSync(requestId);
      const partialText = consumeStreamingText(requestId, {
        emitReset: false,
      });
      const completedAt = Date.now();
      const stopActivities = (all: AgentActivity[]) =>
        all.map((activity) =>
          activity.requestId === requestId &&
          (activity.status === "running" || activity.status === "waiting")
            ? {
                ...activity,
                status: "failed" as const,
                completedAt,
                errorSummary: "操作已停止",
                output: activity.output
                  ? `${activity.output}\n\n操作已停止`
                  : "操作已停止",
              }
            : activity,
        );
      const stoppedActivities = stopActivities(
        activities.length ? activities : (activeTask?.activities ?? []),
      );
      const pausedResult = completionResultFromActivities(
        stoppedActivities.filter(
          (activity) => activity.requestId === requestId,
        ),
        "本轮已停止，已有执行记录和实际改动已保留。",
      );
      const commitStoppedText = (all: ChatMessage[]) =>
        all.map((message) =>
          message.id === `assistant:${requestId}`
            ? {
                ...message,
                content: message.content + partialText,
                completionResult: pausedResult,
                completedAt,
              }
            : message,
        );
      setMessages(commitStoppedText);
      setTasks((all) =>
        all.map((task) =>
          task.id === activeTask?.id
            ? { ...task, messages: commitStoppedText(task.messages) }
            : task,
        ),
      );
      if (previewTimerRef.current)
        window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = undefined;
      if (requestStartedRef.current)
        setDurationMs(completedAt - requestStartedRef.current);
      currentRequest.current = undefined;
      if (activeTask?.id) taskRuntimeStore.finish(activeTask.id, requestId);
      setRunningId(undefined);
      clearPendingReasoning(requestId);
      clearStreamingProgress(requestId);
      setActivities(stoppedActivities);
      if (activeTask?.id)
        setTasks((all) =>
          all.map((task) =>
            task.id === activeTask.id
              ? {
                  ...task,
                  activities: stopActivities(task.activities),
                  runningId: undefined,
                  runStatus: "cancelled",
                  runtimeStatus: "interrupted",
                  updatedAt: completedAt,
                }
              : task,
          ),
        );
      requestTasksRef.current.delete(requestId);
    }
  }

  return { send, cancel };
}
