import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  FileCode2,
  RefreshCw,
  RotateCcw,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import type {
  AgentActivity,
  AgentToolName,
  ChatMessage,
  ContextFile,
  ImageAttachment,
} from "../../types";
import { EMPTY_ACTIVITIES, type QueuedChatMessage } from "../../models";
import { activityFocus, formatDuration, workingPhase } from "../../lib/format";
import { copyWithToast } from "../../lib/toast";
import { MarkdownMessage } from "../common/MarkdownMessage";
import { DiffView } from "../common/DiffView";
import { LinkifiedText } from "../common/LinkifiedText";
import {
  getStreamingText,
  streamingReasoningKey,
  subscribeStreamingText,
} from "../../streaming-text-store";

function MessageItem({
  message,
  running,
  onRetry,
  attachments = [],
  assistantBody,
}: {
  message: ChatMessage;
  running: boolean;
  onRetry(): void;
  attachments?: ContextFile[];
  assistantBody?: React.ReactNode;
}) {
  const queued = (message as QueuedChatMessage).queued;
  const [previewImage, setPreviewImage] = useState<ImageAttachment>();
  useEffect(() => {
    if (!previewImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewImage(undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewImage]);
  const legacyError =
    message.role === "assistant" && message.content.startsWith("请求失败：")
      ? message.content.slice("请求失败：".length)
      : undefined;
  const error = message.error ?? legacyError;
  const isError = Boolean(error);
  return (
    <article className={`message ${message.role} ${isError ? "failed" : ""}`}>
      <div className={`message-avatar ${message.role}`}>
        {message.role === "user" ? <UserRound size={15} /> : <Bot size={16} />}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>
            {message.role === "user" ? "你" : message.model || "Agent"}
          </span>
          {running && (
            <span className="run-state">
              <i />
              生成中
            </span>
          )}
          {message.role === "user" && queued && (
            <span className="queued-state">排队中</span>
          )}
          {isError && (
            <span className="error-state">
              <CircleAlert size={12} />
              执行失败
            </span>
          )}
          <time>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <div className="message-actions">
            <button
              title="复制消息"
              onClick={() => void copyWithToast(message.content)}
            >
              <Copy size={13} />
            </button>
            {isError && (
              <button title="重试" onClick={onRetry}>
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="message-body">
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setPreviewImage(image)}
                  title={`查看原图：${image.name}`}
                >
                  <img src={image.dataUrl} alt={image.name} />
                </button>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((file) => (
                <span key={file.id} title={file.name}>
                  <FileCode2 size={12} />
                  {file.name}
                </span>
              ))}
            </div>
          )}
          {message.role === "assistant" && !legacyError && assistantBody ? (
            assistantBody
          ) : message.content ? (
            message.role === "assistant" && !legacyError ? (
              <MarkdownMessage content={message.content} />
            ) : (
              !legacyError && message.content
            )
          ) : running ? (
            <div className="thinking">
              <span />
              <span />
              <span />
              正在思考
            </div>
          ) : null}
          {error && <div className="message-error">请求失败：{error}</div>}
        </div>
      </div>
      {previewImage &&
        createPortal(
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`查看图片 ${previewImage.name}`}
            onMouseDown={(event) =>
              event.target === event.currentTarget && setPreviewImage(undefined)
            }
          >
            <div className="image-lightbox-content">
              <button
                className="image-lightbox-close"
                type="button"
                title="关闭"
                aria-label="关闭图片预览"
                onClick={() => setPreviewImage(undefined)}
              >
                <X size={18} />
              </button>
              <img src={previewImage.dataUrl} alt={previewImage.name} />
              <span>{previewImage.name}</span>
            </div>
          </div>,
          document.body,
        )}
    </article>
  );
}

function ActivityItem({
  activity,
  requestId,
  workspacePath,
  onActivityChange,
}: {
  activity: AgentActivity;
  requestId?: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
}) {
  const [expanded, setExpanded] = useState(activity.status === "waiting");
  const [undoing, setUndoing] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(() =>
    Math.max(0, (activity.completedAt ?? Date.now()) - activity.startedAt),
  );
  const pending = activity.status === "waiting";
  const detail = activity.diff || activity.output;
  const readableFailure =
    activity.errorSummary ||
    (activity.output && !/[\uFFFD]{1,}|[□�]{1,}/.test(activity.output)
      ? activity.output
      : activity.tool === "run_command"
        ? "命令执行失败，请查看详细输出。"
        : "工具执行失败，请查看详细输出。");
  useEffect(() => {
    if (activity.status === "failed") setExpanded(true);
    // Keep long-running commands expanded so heartbeats/live output stay visible.
    if (activity.status === "running" && activity.output) setExpanded(true);
  }, [activity.status, activity.output]);
  useEffect(() => {
    if (activity.status !== "running") {
      setElapsedMs(
        Math.max(0, (activity.completedAt ?? Date.now()) - activity.startedAt),
      );
      return;
    }
    const update = () => setElapsedMs(Date.now() - activity.startedAt);
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [activity.status, activity.startedAt, activity.completedAt]);
  async function restore(event?: React.MouseEvent, force = false) {
    event?.stopPropagation();
    if (!window.kcode || undoing || activity.undone) return;
    setUndoing(true);
    const result = await window.kcode.chat.undo(
      workspacePath,
      activity.id,
      force,
    );
    if (result.conflict) setRestoreConflict(true);
    else {
      setRestoreConflict(false);
      onActivityChange({
        ...activity,
        undone: result.success,
        undoable: !result.success,
        output: result.success ? result.message : `恢复失败：${result.message}`,
      });
      if (!result.success) setExpanded(true);
    }
    setUndoing(false);
  }
  return (
    <article className={`agent-activity ${activity.status}`}>
      <div
        className="activity-head"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
        aria-expanded={expanded}
      >
        <span className="activity-icon">
          {subagentTools.includes(activity.tool) ? (
            <Bot size={14} />
          ) : commandTools.includes(activity.tool) ? (
            <Terminal size={14} />
          ) : (
            <FileCode2 size={14} />
          )}
        </span>
        <span className="activity-title">
          <strong>{activity.title}</strong>
          <small>
            {activity.command ||
              activity.path ||
              String(activity.input.name || "") ||
              String(activity.input.task || "") ||
              String(activity.input.agentId || "") ||
              String(activity.input.query || "")}
          </small>
        </span>
        {activity.additions !== undefined && (
          <span className="diff-count">
            <b>+{activity.additions}</b>
            <i>-{activity.deletions}</i>
          </span>
        )}
        {activity.undoable && activity.status === "success" && (
          <button
            className="activity-undo"
            disabled={undoing || activity.undone}
            onClick={(event) => void restore(event)}
            title="恢复到本次修改前的版本"
          >
            <RotateCcw size={13} />
            {activity.undone ? "已恢复" : undoing ? "恢复中" : "恢复"}
          </button>
        )}
        <span className="activity-status">
          {pending
            ? "等待确认"
            : activity.status === "running"
              ? "执行中"
              : activity.status === "success"
                ? "完成"
                : activity.status === "completed"
                  ? `退出码 ${activity.exitCode ?? "非0"}`
                  : activity.status === "denied"
                    ? "已阻止"
                    : "失败"}
        </span>
        <ChevronDown size={14} />
      </div>
      {expanded && (
        <div className="activity-detail">
          {pending && requestId && (
            <div className="approval-actions">
              <span>此操作会修改工作区或执行命令</span>
              <button
                onClick={() =>
                  void window.kcode.chat.approve(requestId, activity.id, false)
                }
              >
                拒绝
              </button>
              <button
                className="allow"
                onClick={() =>
                  void window.kcode.chat.approve(requestId, activity.id, true)
                }
              >
                允许
              </button>
            </div>
          )}
          {activity.status === "failed" && (
            <div className="activity-error-reason">
              <CircleAlert size={14} />
              <span>
                <strong>失败原因</strong>
                <small>{readableFailure}</small>
              </span>
            </div>
          )}
          {activity.status === "completed" && (
            <div className="activity-exit-note">
              <CircleAlert size={14} />
              <span>
                <strong>命令已执行完毕</strong>
                <small>
                  退出码 {activity.exitCode ?? "未知"}
                  （非零，通常表示无匹配或有待处理项，并非执行错误）
                </small>
              </span>
            </div>
          )}
          {activity.status === "running" && (
            <div className="activity-running-detail">
              <i className="live-dot" />
              <span>
                <strong>
                  {activity.tool === "ssh_run"
                    ? "等待远程命令返回"
                    : activity.tool === "run_command" &&
                        /\b(ssh|scp|sftp|plink|pscp|putty|ssh-keyscan)\b/i.test(
                          activity.command || "",
                        )
                      ? "网络命令执行中（可能长时间无输出），可点停止强制终止"
                      : activity.tool === "run_command"
                        ? "命令执行中，无输出时也会显示进度心跳"
                        : "操作正在执行"}
                </strong>
                <small>已运行 {formatDuration(elapsedMs)}</small>
              </span>
            </div>
          )}
          {detail && (
            <div className="activity-output-toolbar">
              {(activity.errorSummary ||
                activity.status === "running" ||
                activity.status === "completed") && (
                <div className="activity-output-label">
                  {activity.status === "running" ? "实时输出" : "详细输出"}
                </div>
              )}
              <button
                type="button"
                className="activity-copy-button"
                title="复制输出"
                onClick={(event) => {
                  event.stopPropagation();
                  void copyWithToast(detail);
                }}
              >
                <Copy size={12} />
                复制
              </button>
            </div>
          )}
          {detail &&
            (activity.diff ? (
              <DiffView text={detail} />
            ) : (
              <pre>
                <LinkifiedText text={detail} />
              </pre>
            ))}
        </div>
      )}
      {restoreConflict && (
        <div
          className="restore-backdrop"
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="restore-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`restore-${activity.id}`}
          >
            <div className="restore-dialog-icon">
              <RotateCcw size={17} />
            </div>
            <div>
              <strong id={`restore-${activity.id}`}>文件后来又被修改过</strong>
              <p>
                恢复 <b>{activity.path}</b>{" "}
                会覆盖此版本之后的所有修改。是否仍要恢复到本次修改前？
              </p>
            </div>
            <footer>
              <button onClick={() => setRestoreConflict(false)}>取消</button>
              <button
                className="danger"
                onClick={() => void restore(undefined, true)}
              >
                仍然恢复
              </button>
            </footer>
          </div>
        </div>
      )}
    </article>
  );
}

const subagentTools: AgentToolName[] = [
  "spawn_agent",
  "list_agents",
  "message_agent",
  "wait_agent",
  "stop_agent",
];
const fileTools: AgentToolName[] = [
  "write_file",
  "apply_patch",
  "move_path",
  "delete_path",
  "ssh_write_file",
];
const commandTools: AgentToolName[] = [
  "run_command",
  "ssh_run",
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
  "start_process",
  "stop_process",
  "diagnostics",
];

function activityFileChanges(activity: AgentActivity) {
  if (activity.fileChanges?.length) return activity.fileChanges;
  if (!activity.path) return [];
  return [
    {
      path: activity.path,
      diff: activity.diff,
      additions: activity.additions ?? 0,
      deletions: activity.deletions ?? 0,
    },
  ];
}

const ExecutionSummary = memo(
  function ExecutionSummary({
    activities,
    running,
    requestId,
    workspacePath,
    onActivityChange,
  }: {
    activities: AgentActivity[];
    running: boolean;
    requestId?: string;
    workspacePath: string;
    onActivityChange(activity: AgentActivity): void;
  }) {
    const [expanded, setExpanded] = useState(false);
    // Recomputing these six passes on every streaming flush is wasted work; the
    // result only changes when the activity set changes.
    const { summary, waiting } = useMemo(() => {
      const commands = activities.filter((activity) =>
        commandTools.includes(activity.tool),
      ).length;
      const agents = activities.filter(
        (activity) => activity.tool === "spawn_agent",
      ).length;
      const files = new Set(
        activities
          .filter((activity) => fileTools.includes(activity.tool))
          .flatMap(activityFileChanges)
          .map((change) => change.path),
      ).size;
      const failures = activities.filter(
        (activity) => activity.status === "failed",
      ).length;
      const isWaiting = activities.some(
        (activity) => activity.status === "waiting",
      );
      const inProgress = activities.some(
        (activity) =>
          activity.status === "running" || activity.status === "waiting",
      );
      return {
        waiting: isWaiting,
        summary: [
          commands ? `运行了 ${commands} 个命令` : "",
          agents ? `启动了 ${agents} 个子 Agent` : "",
          files ? `编辑了 ${files} 个文件` : "",
          !commands && !agents && !files
            ? `执行了 ${activities.length} 个步骤`
            : "",
          failures ? `${failures} 项失败` : "",
          running ? (inProgress ? "正在执行" : "正在继续") : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }, [activities, running]);
    useEffect(() => {
      if (waiting) setExpanded(true);
    }, [waiting]);
    if (!activities.length) return null;
    return (
      <section className="execution-summary">
        <button
          className="execution-summary-head"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="execution-summary-icon">
            {running ? <i className="live-dot" /> : <Terminal size={15} />}
          </span>
          <strong>{summary}</strong>
          <ChevronDown size={14} />
        </button>
        {expanded && (
          <div className="execution-summary-detail">
            {activities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                requestId={requestId}
                workspacePath={workspacePath}
                onActivityChange={onActivityChange}
              />
            ))}
          </div>
        )}
      </section>
    );
  },
  (prev, next) => {
    if (
      prev.running !== next.running ||
      prev.requestId !== next.requestId ||
      prev.workspacePath !== next.workspacePath ||
      prev.onActivityChange !== next.onActivityChange ||
      prev.activities.length !== next.activities.length
    )
      return false;
    return prev.activities.every(
      (activity, index) => activity === next.activities[index],
    );
  },
);

function AgentWorkingState({
  activities,
  startedAt,
  hasTrailingText,
  reasoning,
}: {
  activities: AgentActivity[];
  startedAt: number;
  hasTrailingText: boolean;
  reasoning?: string;
}) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const update = () => setElapsedMs(Date.now() - startedAt);
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const active = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.status === "running" || activity.status === "waiting",
    );
  // Pure Q&A (no tools at all): once the answer text starts streaming, drop the
  // "planning" spinner — there is no next step coming. During a multi-step run
  // (activities present) keep spinning through the gaps between tools so it does
  // not flicker off every time the model emits interstitial text.
  if (!active && hasTrailingText && !activities.length) return null;
  const completed = activities.filter(
    (activity) => activity.status === "success",
  ).length;
  const failures = activities.filter(
    (activity) => activity.status === "failed",
  ).length;
  const { phase, detail } = workingPhase(activities, elapsedMs);
  const recent = activities.slice(-3);
  return (
    <div className="agent-working">
      <div className="agent-working-head">
        <span className="agent-working-mark">
          <RefreshCw className="spinning" size={13} />
        </span>
        <span>
          <strong aria-live="polite">{phase}</strong>
          <small>
            {detail}
            {" · "}
            {completed ? `${completed} 步完成` : "准备执行"}
            {failures ? ` · ${failures} 步失败` : ""}
          </small>
        </span>
        <time>{formatDuration(elapsedMs)}</time>
      </div>
      <div className="agent-working-track">
        <i />
      </div>
      {reasoning && !active && (
        <div className="agent-working-reasoning" aria-live="polite">
          {reasoning}
        </div>
      )}
      {recent.length > 0 && (
        <div className="agent-working-recent">
          {recent.map((activity) => (
            <span
              key={activity.id}
              className={activity.status}
              title={activityFocus(activity)}
            >
              {activity.status === "running" ? (
                <RefreshCw className="spinning" size={11} />
              ) : activity.status === "failed" ||
                activity.status === "denied" ? (
                <CircleAlert size={11} />
              ) : activity.status === "waiting" ? (
                <Clock3 size={11} />
              ) : (
                <Check size={11} />
              )}
              {activityFocus(activity)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const AssistantTimeline = memo(function AssistantTimeline({
  message,
  activities,
  running,
  requestId,
  workspacePath,
  onActivityChange,
  reasoning,
}: {
  message: ChatMessage;
  activities: AgentActivity[];
  running: boolean;
  requestId?: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
  reasoning?: string;
}) {
  const renderText = (text: string) =>
    text ? (
      running ? (
        <div className="streaming-message-text">{text}</div>
      ) : (
        <MarkdownMessage content={text} />
      )
    ) : null;
  const grouped = new Map<number, AgentActivity[]>();
  for (const activity of activities) {
    const offset = Math.max(
      0,
      Math.min(
        message.content.length,
        activity.contentOffset ?? message.content.length,
      ),
    );
    grouped.set(offset, [...(grouped.get(offset) ?? []), activity]);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a - b);
  if (!groups.length)
    return (
      <>
        {renderText(message.content)}
        {running && (
          <AgentWorkingState
            activities={activities}
            startedAt={message.createdAt}
            hasTrailingText={Boolean(message.content)}
            reasoning={reasoning}
          />
        )}
      </>
    );
  let cursor = 0;
  const lastActivityOffset = groups.at(-1)?.[0] ?? 0;
  const hasTrailingText = message.content.length > lastActivityOffset;
  return (
    <div className="assistant-timeline">
      {groups.map(([offset, group], index) => {
        const text = message.content.slice(cursor, offset);
        cursor = offset;
        return (
          <div className="assistant-timeline-group" key={`${offset}:${index}`}>
            {renderText(text)}
            <ExecutionSummary
              activities={group}
              running={running && index === groups.length - 1}
              requestId={requestId}
              workspacePath={workspacePath}
              onActivityChange={onActivityChange}
            />
          </div>
        );
      })}
      {renderText(message.content.slice(cursor))}
      {running && (
        <AgentWorkingState
          activities={activities}
          startedAt={message.createdAt}
          hasTrailingText={hasTrailingText}
          reasoning={reasoning}
        />
      )}
    </div>
  );
});

const StreamingAssistantTimeline = memo(function StreamingAssistantTimeline({
  message,
  activities,
  running,
  requestId,
  workspacePath,
  onActivityChange,
  reasoning,
}: {
  message: ChatMessage;
  activities: AgentActivity[];
  running: boolean;
  requestId: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
  reasoning?: string;
}) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeStreamingText(requestId, listener),
    [requestId],
  );
  const getSnapshot = useCallback(() => getStreamingText(requestId), [requestId]);
  const streamedText = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reasoningKey = streamingReasoningKey(requestId);
  const subscribeReasoning = useCallback(
    (listener: () => void) => subscribeStreamingText(reasoningKey, listener),
    [reasoningKey],
  );
  const getReasoningSnapshot = useCallback(
    () => getStreamingText(reasoningKey),
    [reasoningKey],
  );
  const streamedReasoning = useSyncExternalStore(
    subscribeReasoning,
    getReasoningSnapshot,
    getReasoningSnapshot,
  );
  const displayMessage = useMemo(
    () =>
      running && streamedText
        ? { ...message, content: message.content + streamedText }
        : message,
    [message, running, streamedText],
  );

  return (
    <AssistantTimeline
      message={displayMessage}
      activities={activities}
      running={running}
      requestId={running ? requestId : undefined}
      workspacePath={workspacePath}
      onActivityChange={onActivityChange}
      reasoning={streamedReasoning || reasoning}
    />
  );
});

const FileChangesSummary = memo(function FileChangesSummary({
  activities,
}: {
  activities: AgentActivity[];
}) {
  const [expandedFile, setExpandedFile] = useState<string>();
  const changed = activities.filter(
    (activity) =>
      fileTools.includes(activity.tool) &&
      activity.status === "success" &&
      activity.path &&
      !activity.undone,
  );
  const grouped = new Map<
    string,
    { additions: number; deletions: number; diffs: string[] }
  >();
  for (const activity of changed)
    for (const change of activityFileChanges(activity)) {
      const current = grouped.get(change.path) ?? {
        additions: 0,
        deletions: 0,
        diffs: [],
      };
      current.additions += change.additions;
      current.deletions += change.deletions;
      if (change.diff) current.diffs.push(change.diff);
      grouped.set(change.path, current);
    }
  if (!grouped.size) return null;
  const additions = [...grouped.values()].reduce(
    (sum, item) => sum + item.additions,
    0,
  );
  const deletions = [...grouped.values()].reduce(
    (sum, item) => sum + item.deletions,
    0,
  );
  return (
    <section className="file-changes-summary">
      <header>
        <span className="file-changes-icon">
          <FileCode2 size={15} />
        </span>
        <span>
          <strong>已编辑 {grouped.size} 个文件</strong>
          <small>
            <b>+{additions}</b> <i>-{deletions}</i>
          </small>
        </span>
      </header>
      <div>
        {[...grouped.entries()].map(([file, stats]) => {
          const open = expandedFile === file;
          const hasDiff = stats.diffs.length > 0;
          return (
            <div className="changed-file-block" key={file}>
              <button
                type="button"
                className={`changed-file-row ${hasDiff ? "" : "no-diff"}`}
                aria-expanded={open}
                title={hasDiff ? "点击查看改动" : "此改动没有可显示的差异"}
                onClick={() =>
                  hasDiff && setExpandedFile(open ? undefined : file)
                }
              >
                {hasDiff && (
                  <ChevronDown
                    size={13}
                    className={`changed-file-chevron ${open ? "open" : ""}`}
                  />
                )}
                <span title={file}>{file}</span>
                <small>
                  <b>+{stats.additions}</b> <i>-{stats.deletions}</i>
                </small>
              </button>
              {open && hasDiff && <DiffView text={stats.diffs.join("\n\n")} />}
            </div>
          );
        })}
      </div>
    </section>
  );
});

const ConversationMessage = memo(
  function ConversationMessage({
    message,
    activities,
    running,
    workspacePath,
    attachments,
    retryContent,
    onRetry,
    onActivityChange,
    registerTurn,
    reasoning,
  }: {
    message: ChatMessage;
    activities: AgentActivity[];
    running: boolean;
    workspacePath: string;
    attachments?: ContextFile[];
    retryContent?: string;
    onRetry(content: string): void;
    onActivityChange(activity: AgentActivity): void;
    registerTurn(id: string, element: HTMLDivElement | null): void;
    reasoning?: string;
  }) {
    const requestId = message.id.startsWith("assistant:")
      ? message.id.slice("assistant:".length)
      : undefined;
    const turnRef = useCallback(
      (element: HTMLDivElement | null) => registerTurn(message.id, element),
      [message.id, registerTurn],
    );
    return (
      <div
        className="conversation-turn-item"
        ref={message.role === "user" ? turnRef : undefined}
      >
        <MessageItem
          message={message}
          running={running}
          attachments={attachments}
          onRetry={() => retryContent && onRetry(retryContent)}
          assistantBody={
            requestId ? (
              <StreamingAssistantTimeline
                message={message}
                activities={activities}
                running={running}
                requestId={requestId}
                workspacePath={workspacePath}
                onActivityChange={onActivityChange}
                reasoning={reasoning}
              />
            ) : undefined
          }
        />
        {requestId && !running && (
          <FileChangesSummary activities={activities} />
        )}
      </div>
    );
  },
  (previous, next) => {
    if (
      previous.message !== next.message ||
      previous.running !== next.running ||
      previous.workspacePath !== next.workspacePath ||
      previous.attachments !== next.attachments ||
      previous.retryContent !== next.retryContent ||
      previous.onRetry !== next.onRetry ||
      previous.onActivityChange !== next.onActivityChange ||
      previous.registerTurn !== next.registerTurn ||
      previous.reasoning !== next.reasoning ||
      previous.activities.length !== next.activities.length
    )
      return false;
    return previous.activities.every(
      (activity, index) => activity === next.activities[index],
    );
  },
);

export const ConversationHistory = memo(
  function ConversationHistoryInner({
    messages,
    hasOlderMessages,
    hasNewerMessages,
    activitiesByRequest,
    runningId,
    workspacePath,
    contextByMessage,
    retryContent,
    onRetry,
    onActivityChange,
    registerTurn,
    endRef,
    reasoning,
  }: {
    messages: ChatMessage[];
    hasOlderMessages: boolean;
    hasNewerMessages: boolean;
    activitiesByRequest: Map<string, AgentActivity[]>;
    runningId?: string;
    workspacePath: string;
    contextByMessage: Map<string, ContextFile[]>;
    retryContent?: string;
    onRetry(content: string): void;
    onActivityChange(activity: AgentActivity): void;
    registerTurn(id: string, element: HTMLDivElement | null): void;
    endRef: React.RefObject<HTMLDivElement | null>;
    reasoning?: string;
  }) {
    return (
      <div className="message-list" aria-live="polite">
        {hasOlderMessages && (
          <div className="conversation-history-loader" aria-hidden="true">
            <span />
            向上滚动加载更早对话
          </div>
        )}
        {messages.map((message) => {
          const requestId = message.id.startsWith("assistant:")
            ? message.id.slice("assistant:".length)
            : undefined;
          return (
            <ConversationMessage
              key={message.id}
              message={message}
              activities={
                requestId
                  ? (activitiesByRequest.get(requestId) ?? EMPTY_ACTIVITIES)
                  : EMPTY_ACTIVITIES
              }
              running={Boolean(requestId) && requestId === runningId}
              workspacePath={workspacePath}
              attachments={contextByMessage.get(message.id)}
              retryContent={retryContent}
              onRetry={onRetry}
              onActivityChange={onActivityChange}
              registerTurn={registerTurn}
              reasoning={
                Boolean(requestId) && requestId === runningId
                  ? reasoning
                  : undefined
              }
            />
          );
        })}
        {hasNewerMessages && (
          <div className="conversation-history-loader newer" aria-hidden="true">
            <span />
            向下滚动加载较新对话
          </div>
        )}
        <div ref={endRef} />
      </div>
    );
  },
  (prev, next) => {
    if (prev.messages.length !== next.messages.length) return false;
    if (prev.runningId !== next.runningId) return false;
    if (prev.reasoning !== next.reasoning) return false;
    if (prev.hasOlderMessages !== next.hasOlderMessages) return false;
    if (prev.hasNewerMessages !== next.hasNewerMessages) return false;
    if (prev.retryContent !== next.retryContent) return false;
    if (prev.workspacePath !== next.workspacePath) return false;
    const prevLast = prev.messages[prev.messages.length - 1];
    const nextLast = next.messages[next.messages.length - 1];
    if (prevLast && nextLast) {
      if ((prevLast.content?.length ?? 0) !== (nextLast.content?.length ?? 0))
        return false;
    }
    if (prev.activitiesByRequest !== next.activitiesByRequest) return false;
    return true;
  },
);
