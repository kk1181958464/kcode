import { useAgentStream } from "./useAgentStream";
import { useLayoutEffect } from "react";
import type { RemoteCommandEnvelope } from "../remote-types";
import {
  materializeRemoteAttachments,
  remoteAttachmentPrompt,
} from "../remote-attachments";
import { remoteTaskSnapshot } from "../remote-snapshot";
import { uid, type QueuedChatMessage, type TaskRecord } from "../models";
import { taskRuntimeStore } from "../task-runtime-store";
import { errorMessage } from "../lib/format";
import { useEventCallback } from "../lib/use-event-callback";
import { completionResultFromActivities } from "../completion-summary";
import type { ChatMessage, ContextFile } from "../types";
import type { Dispatch, RefObject, SetStateAction } from "react";
type RemoteTaskCommandsBindings = {
  remoteCommandHandlerRef: RefObject<(command: RemoteCommandEnvelope) => void>;
  tasksRef: RefObject<TaskRecord[]>;
  ensureTaskLoaded: (task: TaskRecord) => Promise<TaskRecord>;
  flushRemoteStreamSync: ReturnType<
    typeof useAgentStream
  >["flushRemoteStreamSync"];
  contextByMessageRef: RefObject<Map<string, ContextFile[]>>;
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  displayedTaskIdRef: RefObject<string>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  currentRequest: RefObject<string | undefined>;
  cancel: () => Promise<void>;
};

export function useRemoteTaskCommands({
  remoteCommandHandlerRef,
  tasksRef,
  ensureTaskLoaded,
  flushRemoteStreamSync,
  contextByMessageRef,
  setTasks,
  displayedTaskIdRef,
  setMessages,
  currentRequest,
  cancel,
}: RemoteTaskCommandsBindings) {
  const handleCommand = useEventCallback((envelope: RemoteCommandEnvelope) => {
    void (async () => {
      try {
        const command = envelope.command;
        const current = tasksRef.current.find(
          (task) => task.id === command.taskId,
        );
        if (!current) throw new Error("手机选择的任务已不存在");
        const task = await ensureTaskLoaded(current);
        if (command.type === "task.load") {
          await window.kcode.remote.syncTasks(
            tasksRef.current
              .map((item) => (item.id === task.id ? task : item))
              .map(remoteTaskSnapshot),
          );
          if (task.runningId) flushRemoteStreamSync(task.runningId);
        } else if (command.type === "task.send") {
          const messageId = command.clientMessageId || uid();
          const alreadyQueued = tasksRef.current.some(
            (item) =>
              item.id === task.id &&
              item.messages.some((message) => message.id === messageId),
          );
          if (alreadyQueued) {
            await window.kcode.remote.syncTasks(
              tasksRef.current.map(remoteTaskSnapshot),
            );
            await window.kcode.remote.commandResult(envelope.id, true);
            return;
          }
          const { images, files } = materializeRemoteAttachments(
            command.attachments,
          );
          const content = remoteAttachmentPrompt(
            command.content,
            images.length,
            files.length,
          );
          const user: QueuedChatMessage = {
            id: messageId,
            role: "user",
            content,
            createdAt: Date.now(),
            images: images.length ? images : undefined,
            contextAttachments: files.length
              ? files.map(({ name, size }) => ({ name, size }))
              : undefined,
            queued: true,
          };
          contextByMessageRef.current.set(user.id, files);
          const nextTasks = tasksRef.current.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  messages: [...item.messages, user],
                  updatedAt: Date.now(),
                }
              : item,
          );
          tasksRef.current = nextTasks;
          setTasks(nextTasks);
          if (displayedTaskIdRef.current === task.id)
            setMessages((all) =>
              all.some((message) => message.id === user.id)
                ? all
                : [...all, user],
            );
        } else if (command.type === "task.cancel") {
          if (!task.runningId) throw new Error("任务当前没有在运行");
          if (
            displayedTaskIdRef.current === task.id &&
            currentRequest.current === task.runningId
          )
            await cancel();
          else {
            await window.kcode.chat.cancel(task.runningId);
            const completedAt = Date.now();
            const requestId = task.runningId;
            const stoppedActivities = task.activities.map((activity) =>
              activity.requestId === requestId &&
              (activity.status === "running" || activity.status === "waiting")
                ? {
                    ...activity,
                    status: "failed" as const,
                    completedAt,
                    errorSummary: "操作已从手机停止",
                    output: activity.output
                      ? `${activity.output}\n\n操作已从手机停止`
                      : "操作已从手机停止",
                  }
                : activity,
            );
            const pausedResult = completionResultFromActivities(
              stoppedActivities.filter(
                (activity) => activity.requestId === requestId,
              ),
              "本轮已从手机停止，已有执行记录和实际改动已保留。",
            );
            taskRuntimeStore.finish(task.id, task.runningId);
            setTasks((all) =>
              all.map((item) =>
                item.id === task.id
                  ? {
                      ...item,
                      runningId: undefined,
                      runStatus: "cancelled",
                      runtimeStatus: "interrupted",
                      updatedAt: completedAt,
                      messages: item.messages.map((message) =>
                        message.id === `assistant:${requestId}`
                          ? {
                              ...message,
                              completionResult: pausedResult,
                              completedAt,
                            }
                          : message,
                      ),
                      activities: stoppedActivities,
                    }
                  : item,
              ),
            );
          }
        } else if (command.type === "task.approve") {
          await window.kcode.chat.approve(
            command.requestId,
            command.activityId,
            command.allowed,
          );
        }
        await window.kcode.remote.commandResult(envelope.id, true);
      } catch (error) {
        await window.kcode?.remote?.commandResult(
          envelope.id,
          false,
          errorMessage(error),
        );
      }
    })();
  });
  useLayoutEffect(() => {
    remoteCommandHandlerRef.current = handleCommand;
    return () => {
      remoteCommandHandlerRef.current = () => undefined;
    };
  }, [handleCommand, remoteCommandHandlerRef]);
}
