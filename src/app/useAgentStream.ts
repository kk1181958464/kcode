import { startTransition, useEffect, useRef } from "react";
import { resolveModelContextWindow } from "../types";
import type {
  RemoteControlState,
  RemoteTaskStreamEvent,
} from "../remote-types";
import type { SshRemoteState } from "../ssh-remote-types";
import { sshWorkspaceRootFromActivity } from "../ssh-workspace-activity";
import { attachSshWorkspace } from "../task-workspace";
import { observeContextWindow } from "../context-window";
import { type TaskRecord } from "../models";
import { sidebarWorkspaceKey } from "../sidebar-projection";
import { taskRuntimeStore } from "../task-runtime-store";
import { errorMessage } from "../lib/format";
import {
  STREAM_PACING_INTERVAL_MS,
  STREAM_SINGLETON_MAX_HOLD_MS,
  StreamPacingBuffer,
} from "../stream-pacing";
import {
  appendStreamingText,
  consumeStreamingText,
  getStreamingTextTail,
  replaceStreamingText,
  resetStreamingText,
  streamingProgressKey,
  streamingReasoningKey,
} from "../streaming-text-store";
import { acceptStreamSequence } from "../stream-sequence";
import {
  appendActivityOutput,
  replaceActivityOutput,
  resetActivityOutput,
} from "../activity-output-store";
import { upsertActivity } from "../activity-index";
import {
  finishTaskRequest,
  isTaskViewCurrent,
  isRetryableDisconnectError,
} from "../task-status";
import { truncateAssistantMessageForTextReset } from "../conversation-rendering";
import { completionResultFromActivities } from "../completion-summary";
import type { AgentActivity, ChatMessage, ProviderConfig } from "../types";

type AgentStreamBindings = {
  remoteStreamTimersRef: React.RefObject<Map<string, number>>;
  requestTasksRef: React.RefObject<Map<string, string>>;
  remoteStreamSequencesRef: React.RefObject<Map<string, number>>;
  remoteRuntimeMetaRef: React.RefObject<
    Map<
      string,
      {
        eventId?: string;
        eventKind?: string;
        itemStatus?: string;
        sequence?: number;
        protocolVersion?: number;
      }
    >
  >;
  remoteControlState: RemoteControlState;
  tasksRef: React.RefObject<TaskRecord[]>;
  pendingTextRef: React.RefObject<Map<string, StreamPacingBuffer>>;
  composerInputBusyUntilRef: React.RefObject<number>;
  pendingTextSinceRef: React.RefObject<Map<string, number>>;
  textFlushTimerRef: React.RefObject<number | undefined>;
  pendingReasoningRef: React.RefObject<Map<string, string>>;
  reasoningFlushTimerRef: React.RefObject<number | undefined>;
  currentRequest: React.RefObject<string | undefined>;
  adoptedSshActivitiesRef: React.RefObject<Set<string>>;
  setContextError: React.Dispatch<React.SetStateAction<string>>;
  activeTaskIdRef: React.RefObject<string>;
  expandWorkspace: (workspaceKey: string) => void;
  setTasks: React.Dispatch<React.SetStateAction<TaskRecord[]>>;
  setSshRemoteState: React.Dispatch<
    React.SetStateAction<SshRemoteState | undefined>
  >;
  displayedTaskIdRef: React.RefObject<string>;
  agentEventSequencesRef: React.RefObject<Map<string, number>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setActivities: React.Dispatch<React.SetStateAction<AgentActivity[]>>;
  modelsRef: React.RefObject<
    {
      provider: ProviderConfig;
      model: import("../types").ModelConfig;
    }[]
  >;
  setTokenCalibration: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
  setUsage: React.Dispatch<
    React.SetStateAction<{
      input: number;
      output: number;
      cached: number;
      promptTokens?: number;
    }>
  >;
  setUsageResolved: React.Dispatch<React.SetStateAction<boolean>>;
  requestStartedRef: React.RefObject<number | undefined>;
  setDurationMs: React.Dispatch<React.SetStateAction<number>>;
  setRunningId: React.Dispatch<React.SetStateAction<string | undefined>>;
};

export function useAgentStream({
  remoteStreamTimersRef,
  requestTasksRef,
  remoteStreamSequencesRef,
  remoteRuntimeMetaRef,
  remoteControlState,
  tasksRef,
  pendingTextRef,
  composerInputBusyUntilRef,
  pendingTextSinceRef,
  textFlushTimerRef,
  pendingReasoningRef,
  reasoningFlushTimerRef,
  currentRequest,
  adoptedSshActivitiesRef,
  setContextError,
  activeTaskIdRef,
  expandWorkspace,
  setTasks,
  setSshRemoteState,
  displayedTaskIdRef,
  agentEventSequencesRef,
  setMessages,
  setActivities,
  modelsRef,
  setTokenCalibration,
  setUsage,
  setUsageResolved,
  requestStartedRef,
  setDurationMs,
  setRunningId,
}: AgentStreamBindings) {
  useEffect(
    () => () => {
      for (const timer of remoteStreamTimersRef.current.values())
        window.clearTimeout(timer);
      remoteStreamTimersRef.current.clear();
      if (textFlushTimerRef.current)
        window.clearTimeout(textFlushTimerRef.current);
      if (reasoningFlushTimerRef.current)
        window.clearTimeout(reasoningFlushTimerRef.current);
      textFlushTimerRef.current = undefined;
      reasoningFlushTimerRef.current = undefined;
    },
    [remoteStreamTimersRef, textFlushTimerRef, reasoningFlushTimerRef],
  );

  // Stream handlers are registered once, so read connectivity through a ref.
  const remoteConnectedRef = useRef(remoteControlState.connected);
  remoteConnectedRef.current = remoteControlState.connected;

  function flushRemoteStreamSync(requestId: string) {
    const scheduled = remoteStreamTimersRef.current.get(requestId);
    if (scheduled) window.clearTimeout(scheduled);
    remoteStreamTimersRef.current.delete(requestId);
    const taskId = requestTasksRef.current.get(requestId);
    const remote = window.kcode?.remote;
    // No listener: skip. The reconnect effect below resyncs running tasks.
    if (!taskId || !remote || !remoteConnectedRef.current) return;
    const sequence = (remoteStreamSequencesRef.current.get(requestId) ?? 0) + 1;
    remoteStreamSequencesRef.current.set(requestId, sequence);
    const event: RemoteTaskStreamEvent = {
      type: "task.event",
      event: "stream",
      taskId,
      requestId,
      sequence,
      content: getStreamingTextTail(requestId, 96_000).text,
      reasoning: getStreamingTextTail(streamingReasoningKey(requestId), 8_000)
        .text,
      progress: getStreamingTextTail(streamingProgressKey(requestId), 1_000)
        .text,
      runtimeEventId: remoteRuntimeMetaRef.current.get(requestId)?.eventId,
      runtimeEventKind: remoteRuntimeMetaRef.current.get(requestId)?.eventKind,
      runtimeItemStatus:
        remoteRuntimeMetaRef.current.get(requestId)?.itemStatus,
      runtimeSequence: remoteRuntimeMetaRef.current.get(requestId)?.sequence,
      runtimeProtocolVersion:
        remoteRuntimeMetaRef.current.get(requestId)?.protocolVersion,
      updatedAt: Date.now(),
    };
    void remote.syncTaskEvent(event).catch(() => undefined);
  }

  function scheduleRemoteStreamSync(requestId: string) {
    if (!remoteConnectedRef.current) return;
    if (remoteStreamTimersRef.current.has(requestId)) return;
    remoteStreamTimersRef.current.set(
      requestId,
      window.setTimeout(() => flushRemoteStreamSync(requestId), 180),
    );
  }

  useEffect(() => {
    if (!remoteControlState.connected) return;
    const timer = window.setTimeout(() => {
      for (const [requestId, taskId] of requestTasksRef.current) {
        const task = tasksRef.current.find((item) => item.id === taskId);
        if (task?.runningId === requestId) flushRemoteStreamSync(requestId);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [remoteControlState.connected]);

  function flushPendingText(drainAll = false) {
    if (!pendingTextRef.current.size) return;
    if (!drainAll && performance.now() < composerInputBusyUntilRef.current) {
      scheduleTextFlush(
        Math.max(16, composerInputBusyUntilRef.current - performance.now()),
      );
      return;
    }
    const slices: [string, string][] = [];
    const now = Date.now();
    for (const [requestId, buffered] of pendingTextRef.current) {
      if (!buffered.length) continue;
      const bufferedSince = pendingTextSinceRef.current.get(requestId) ?? now;
      const slice = buffered.take(
        drainAll,
        now - bufferedSince >= STREAM_SINGLETON_MAX_HOLD_MS,
      );
      if (slice) slices.push([requestId, slice]);
      if (!buffered.length) {
        pendingTextRef.current.delete(requestId);
        pendingTextSinceRef.current.delete(requestId);
      }
    }
    if (!slices.length) {
      if (!drainAll && pendingTextRef.current.size) scheduleTextFlush();
      return;
    }
    for (const [requestId, delta] of slices) {
      appendStreamingText(requestId, delta);
      scheduleRemoteStreamSync(requestId);
    }
    if (!drainAll && pendingTextRef.current.size) scheduleTextFlush();
  }

  function scheduleTextFlush(delay = STREAM_PACING_INTERVAL_MS) {
    if (textFlushTimerRef.current) return;
    textFlushTimerRef.current = window.setTimeout(() => {
      textFlushTimerRef.current = undefined;
      flushPendingText();
    }, delay);
  }

  function clearPendingReasoning(requestId = currentRequest.current) {
    if (requestId) {
      pendingReasoningRef.current.delete(requestId);
      resetStreamingText(streamingReasoningKey(requestId));
      scheduleRemoteStreamSync(requestId);
    } else {
      for (const id of pendingReasoningRef.current.keys())
        resetStreamingText(streamingReasoningKey(id));
      pendingReasoningRef.current.clear();
    }
    if (reasoningFlushTimerRef.current) {
      window.clearTimeout(reasoningFlushTimerRef.current);
      reasoningFlushTimerRef.current = undefined;
    }
    if (pendingReasoningRef.current.size) scheduleReasoningFlush();
  }

  function clearStreamingProgress(requestId: string) {
    resetStreamingText(streamingProgressKey(requestId));
    scheduleRemoteStreamSync(requestId);
  }

  function adoptActivitySshWorkspace(taskId: string, activity: AgentActivity) {
    const rootPath = sshWorkspaceRootFromActivity(activity);
    if (!window.kcode?.sshRemote || !rootPath) return;
    const adoptionKey = `${taskId}:${activity.id}:${rootPath}`;
    if (adoptedSshActivitiesRef.current.has(adoptionKey)) return;
    adoptedSshActivitiesRef.current.add(adoptionKey);
    void window.kcode.sshRemote
      .adopt(taskId, rootPath)
      .then((state) => {
        if (!state.profile || !state.cachePath)
          throw new Error("SSH 连接未返回可编辑的远程工作区。");
        const currentTask = tasksRef.current.find((task) => task.id === taskId);
        if (currentTask)
          expandWorkspace(
            sidebarWorkspaceKey({
              ...currentTask,
              workspacePath: state.cachePath,
              remoteWorkspace: state.profile,
            }),
          );
        setTasks((all) =>
          all.map((task) =>
            task.id === taskId
              ? attachSshWorkspace(task, {
                  profile: state.profile!,
                  cachePath: state.cachePath!,
                })
              : task,
          ),
        );
        if (
          isTaskViewCurrent(
            activeTaskIdRef.current,
            displayedTaskIdRef.current,
            taskId,
          )
        ) {
          setSshRemoteState(state);
        }
      })
      .catch((error) => {
        adoptedSshActivitiesRef.current.delete(adoptionKey);
        if (activeTaskIdRef.current === taskId)
          setContextError(
            `SSH 已连接，但打开远程编辑器失败：${errorMessage(error)}`,
          );
      });
  }

  function scheduleReasoningFlush() {
    if (reasoningFlushTimerRef.current) return;
    reasoningFlushTimerRef.current = window.setTimeout(() => {
      reasoningFlushTimerRef.current = undefined;
      const pending = [...pendingReasoningRef.current.entries()];
      pendingReasoningRef.current.clear();
      for (const [requestId, delta] of pending) {
        appendStreamingText(streamingReasoningKey(requestId), delta);
        scheduleRemoteStreamSync(requestId);
      }
    }, 100);
  }

  useEffect(
    () =>
      window.kcode?.chat.onEvent((id, event) => {
        if (
          !acceptStreamSequence(
            agentEventSequencesRef.current,
            id,
            event.sequence,
          )
        )
          return;
        const taskId = requestTasksRef.current.get(id) ?? event.taskId;
        if (!taskId) return;
        if (!requestTasksRef.current.has(id))
          requestTasksRef.current.set(id, taskId);
        if (event.eventId)
          remoteRuntimeMetaRef.current.set(id, {
            eventId: event.eventId,
            eventKind: event.eventKind,
            itemStatus: event.itemStatus,
            sequence: event.sequence,
            protocolVersion: event.protocolVersion,
          });
        const isActive = isTaskViewCurrent(
          activeTaskIdRef.current,
          displayedTaskIdRef.current,
          taskId,
        );
        if (
          event.type !== "done" &&
          event.type !== "error" &&
          event.type !== "activity_output"
        ) {
          taskRuntimeStore.applyEvent(taskId, id, event);
        }
        if (event.type === "activity_output") {
          if (event.mode === "append")
            appendActivityOutput(event.activityId, event.value);
          else replaceActivityOutput(event.activityId, event.value);
          return;
        }
        if (
          event.type !== "done" &&
          event.type !== "error" &&
          event.type !== "text" &&
          event.type !== "final_response" &&
          event.type !== "reasoning" &&
          event.type !== "reasoning_reset" &&
          event.type !== "progress"
        )
          setTasks((all) => {
            const index = all.findIndex((task) => task.id === taskId);
            const task = all[index];
            if (
              !task ||
              (task.runningId === id && task.runStatus === "running")
            )
              return all;
            const next = [...all];
            next[index] = {
              ...task,
              runningId: id,
              runStatus: "running",
              runtimeStatus: taskRuntimeStore.get(taskId)?.state.threadStatus,
            };
            return next;
          });
        if (event.type === "final_response") {
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          const settledText = consumeStreamingText(id, { emitReset: false });
          const markFinalResponse = (all: ChatMessage[]) =>
            all.map((message) => {
              if (message.id !== `assistant:${id}`) return message;
              const content = message.content + settledText;
              return {
                ...message,
                content,
                finalResponseOffset: Math.min(
                  content.length,
                  Math.max(0, Math.floor(event.textOffset)),
                ),
                finalResponseStartedAt: event.startedAt,
                finalResponseProcess: event.processKind,
              };
            });
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: markFinalResponse(task.messages),
                    updatedAt: Math.max(task.updatedAt, event.startedAt),
                  }
                : task,
            ),
          );
          if (isActive) setMessages(markFinalResponse);
          flushRemoteStreamSync(id);
          return;
        }
        if (event.type === "activity") {
          flushPendingText(true);
          const settledText = consumeStreamingText(id, { emitReset: false });
          const settleMessages = (all: ChatMessage[]) =>
            settledText
              ? all.map((message) =>
                  message.id === `assistant:${id}`
                    ? { ...message, content: message.content + settledText }
                    : message,
                )
              : all;
          resetActivityOutput(event.activity.id);
          const updateActivities = (all: AgentActivity[]) =>
            upsertActivity(all, event.activity);
          adoptActivitySshWorkspace(taskId, event.activity);
          // Commit the narration on the urgent lane before the activity card.
          // Keeping both updates in the transition can defer the text until a
          // fast sequence of tool lifecycle events has finished.
          if (settledText) {
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId
                  ? { ...task, messages: settleMessages(task.messages) }
                  : task,
              ),
            );
            if (isActive) setMessages(settleMessages);
          }
          startTransition(() => {
            setTasks((all) =>
              all.map((task) =>
                task.id === taskId
                  ? {
                      ...task,
                      activities: updateActivities(task.activities),
                      updatedAt: Date.now(),
                    }
                  : task,
              ),
            );
            if (isActive) {
              setActivities(updateActivities);
            }
          });
          return;
        }
        if (event.type === "reasoning_reset") {
          clearPendingReasoning(id);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "reasoning") {
          clearStreamingProgress(id);
          pendingReasoningRef.current.set(
            id,
            (pendingReasoningRef.current.get(id) ?? "") + event.delta,
          );
          scheduleReasoningFlush();
          return;
        }
        if (event.type === "progress") {
          // A new planning/recovery phase replaces the previous round's live
          // reasoning. It remains visible while the selected tool is running.
          clearPendingReasoning(id);
          replaceStreamingText(streamingProgressKey(id), event.message);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "context_compaction") {
          replaceStreamingText(
            streamingProgressKey(id),
            event.phase === "started"
              ? event.strategy === "model"
                ? "上下文接近预算，正在让模型整理较早运行记录…"
                : "上下文接近预算，正在准备安全整理…"
              : event.changed
                ? event.strategy === "model"
                  ? `模型已整理上下文${event.modelId ? `（${event.modelId}）` : ""}：${event.beforeItems} → ${event.afterItems ?? event.beforeItems} 条，继续执行…`
                  : `已安全整理上下文：${event.beforeItems} → ${event.afterItems ?? event.beforeItems} 条，继续执行…`
                : "上下文仍在预算内，继续执行…",
          );
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "text_reset") {
          // Upstream broke mid-answer and the agent is retrying: discard the
          // current turn while retaining text from earlier timeline rounds.
          // Drain first because an auto-continued prefix may still be paced in
          // memory rather than committed to message.content.
          flushPendingText(true);
          pendingTextRef.current.delete(id);
          pendingTextSinceRef.current.delete(id);
          const streamedText = consumeStreamingText(id, { emitReset: false });
          const clearCommitted = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? truncateAssistantMessageForTextReset(
                    message,
                    event.textOffset,
                    streamedText,
                    event.replacement,
                  )
                : message,
            );
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? { ...task, messages: clearCommitted(task.messages) }
                : task,
            ),
          );
          if (isActive) setMessages(clearCommitted);
          scheduleRemoteStreamSync(id);
          return;
        }
        if (event.type === "text") {
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (!isActive) {
            // A task switched away mid-stream may still have paced text sitting
            // in its buffer waiting on the flush timer. Writing this delta
            // straight to the store would land ahead of that buffered text and
            // reorder the answer. Drain the buffer in order first.
            const buffered = pendingTextRef.current.get(id);
            if (buffered) {
              buffered.append(event.delta);
              appendStreamingText(id, buffered.take(true));
              pendingTextRef.current.delete(id);
              pendingTextSinceRef.current.delete(id);
            } else {
              appendStreamingText(id, event.delta);
            }
            scheduleRemoteStreamSync(id);
            return;
          }
          let pending = pendingTextRef.current.get(id);
          if (!pending) {
            pending = new StreamPacingBuffer();
            pendingTextRef.current.set(id, pending);
            pendingTextSinceRef.current.set(id, Date.now());
          }
          pending.append(event.delta);
          scheduleTextFlush();
        }
        if (event.type === "usage") {
          const nextUsage = {
            input: event.input,
            output: event.output,
            cached: event.cached ?? 0,
            promptTokens: event.promptTokens ?? event.input,
          };
          const task = tasksRef.current.find((item) => item.id === taskId);
          const taskModel = modelsRef.current.find(
            (item) =>
              `${item.provider.id}|${item.model.id}` === task?.modelSelection,
          )?.model;
          // Calibrate against the last round's prompt tokens (the real context
          // occupancy), not the accumulated billing total which grows every round.
          const observedInput = event.promptTokens ?? event.input;
          if (
            observedInput > 0 &&
            task?.pendingTokenEstimate &&
            task.pendingCalibrationKey
          ) {
            const observed = Math.min(
              2.5,
              Math.max(0.5, observedInput / task.pendingTokenEstimate),
            );
            setTokenCalibration((current) => {
              const previous = current[task.pendingCalibrationKey!] ?? 1;
              const next = {
                ...current,
                [task.pendingCalibrationKey!]:
                  Math.round((previous * 0.75 + observed * 0.25) * 1000) / 1000,
              };
              localStorage.setItem(
                "kcode.tokenCalibration",
                JSON.stringify(next),
              );
              return next;
            });
          }
          setTasks((all) =>
            all.map((item) =>
              item.id === taskId
                ? {
                    ...item,
                    usage: nextUsage,
                    contextWindowState: observeContextWindow(
                      item.contextWindowState,
                      {
                        taskId,
                        limit: resolveModelContextWindow(
                          taskModel?.modelId ?? "",
                          taskModel?.contextWindow,
                        ),
                        observedTokens: observedInput,
                        estimatedTokens: observedInput,
                        source: "reported",
                      },
                    ),
                    usageResolved: true,
                    pendingTokenEstimate: undefined,
                    pendingCalibrationKey: undefined,
                  }
                : item,
            ),
          );
          if (isActive) {
            setUsage(nextUsage);
            setUsageResolved(true);
          }
        }
        if (event.type === "error") {
          const interrupted =
            event.code === "cancelled" ||
            event.eventKind === "turn_interrupted";
          const retryableDisconnect =
            !interrupted &&
            (event.retryable ?? isRetryableDisconnectError(event.message));
          taskRuntimeStore.finish(taskId, id);
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id, { emitReset: false });
          const completedAt = Date.now();
          const pausedDisconnectResult = retryableDisconnect
            ? completionResultFromActivities(
                (
                  tasksRef.current.find((task) => task.id === taskId)
                    ?.activities ?? []
                ).filter((activity) => activity.requestId === id),
                event.message,
              )
            : undefined;
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? {
                    ...message,
                    content: message.content + finalText,
                    error:
                      interrupted || retryableDisconnect
                        ? undefined
                        : event.message,
                    ...(pausedDisconnectResult
                      ? { completionResult: pausedDisconnectResult }
                      : {}),
                    completedAt,
                  }
                : message,
            );
          const updateMessages = (all: ChatMessage[]) => commitFinalText(all);
          const errorDurationMs =
            isActive && requestStartedRef.current
              ? completedAt - requestStartedRef.current
              : undefined;
          setTasks((all) =>
            all.map((task) =>
              task.id === taskId
                ? {
                    ...task,
                    messages: updateMessages(task.messages),
                    ...finishTaskRequest(
                      task.runningId,
                      id,
                      task.runStatus === "cancelled" || interrupted
                        ? "cancelled"
                        : retryableDisconnect
                          ? "paused"
                          : "failed",
                    ),
                    runtimeStatus:
                      task.runningId && task.runningId !== id
                        ? "running"
                        : task.runStatus === "cancelled" || interrupted
                          ? "interrupted"
                          : retryableDisconnect
                            ? "completed"
                            : "failed",
                    usageResolved: true,
                    ...(errorDurationMs !== undefined
                      ? { durationMs: errorDurationMs }
                      : {}),
                    updatedAt: completedAt,
                  }
                : task,
            ),
          );
          if (isActive) setMessages(updateMessages);
          if (errorDurationMs !== undefined) setDurationMs(errorDurationMs);
          if (isActive && currentRequest.current === id) {
            currentRequest.current = undefined;
            setRunningId(undefined);
          }
          if (isActive) setUsageResolved(true);
          requestTasksRef.current.delete(id);
          remoteRuntimeMetaRef.current.delete(id);
        }
        if (event.type === "done") {
          taskRuntimeStore.finish(taskId, id);
          const finishedStatus =
            event.outcome === "blocked"
              ? "blocked"
              : event.outcome === "paused"
                ? "paused"
                : "completed";
          clearStreamingProgress(id);
          clearPendingReasoning(id);
          if (textFlushTimerRef.current) {
            window.clearTimeout(textFlushTimerRef.current);
            textFlushTimerRef.current = undefined;
          }
          flushPendingText(true);
          flushRemoteStreamSync(id);
          const finalText = consumeStreamingText(id, { emitReset: false });
          const completedAt = Date.now();
          const commitFinalText = (all: ChatMessage[]) =>
            all.map((message) =>
              message.id === `assistant:${id}`
                ? {
                    ...message,
                    content: message.content + finalText,
                    completionResult: event.result,
                    completedAt,
                  }
                : message,
            );
          if (isActive) setMessages(commitFinalText);
          const doneDurationMs =
            isActive && requestStartedRef.current
              ? completedAt - requestStartedRef.current
              : undefined;
          setTasks((all) =>
            all.map((task) => {
              if (task.id !== taskId) return task;
              const committedMessages = commitFinalText(task.messages);
              const assistantIndex = committedMessages.findIndex(
                (message) => message.id === `assistant:${id}`,
              );
              const assistant = committedMessages[assistantIndex];
              const user = [...committedMessages.slice(0, assistantIndex)]
                .reverse()
                .find(
                  (message) =>
                    message.role === "user" && message.images?.length,
                );
              const imageSemantics = { ...(task.imageSemantics ?? {}) };
              if (assistant?.content && user?.images)
                for (const image of user.images)
                  imageSemantics[image.id] = assistant.content.slice(0, 4_000);
              return {
                ...task,
                messages: committedMessages,
                ...finishTaskRequest(task.runningId, id, finishedStatus),
                runtimeStatus:
                  task.runningId && task.runningId !== id
                    ? "running"
                    : event.outcome === "blocked"
                      ? "waiting"
                      : "completed",
                usageResolved: true,
                imageSemantics,
                ...(doneDurationMs !== undefined
                  ? { durationMs: doneDurationMs }
                  : {}),
                updatedAt: completedAt,
              };
            }),
          );
          if (doneDurationMs !== undefined) setDurationMs(doneDurationMs);
          if (isActive && currentRequest.current === id) {
            currentRequest.current = undefined;
            setRunningId(undefined);
            setUsageResolved(true);
          }
          requestTasksRef.current.delete(id);
          remoteRuntimeMetaRef.current.delete(id);
        }
      }) ?? (() => undefined),
    [],
  );
  return {
    flushRemoteStreamSync,
    flushPendingText,
    clearPendingReasoning,
    clearStreamingProgress,
  };
}
