import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Cpu,
  Clock3,
  FileCode2,
  FolderOpen,
  ListChecks,
  LoaderCircle,
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
import {
  activityExecutionNarrative,
  executionNarrativePreview,
} from "../../execution-narrative";
import {
  normalizeActivity,
  summarizeActivities,
} from "../../activity-view-model";
import {
  summarizeExecutionPlan,
  type ExecutionPlanStepStatus,
} from "../../execution-plan";
import {
  activityFocus,
  activityTarget,
  formatCompactDuration,
  formatDuration,
} from "../../lib/format";
import { copyWithToast } from "../../lib/toast";
import { revealLocalPath } from "../../lib/reveal-path";
import { effortLabels } from "../../lib/model-utils";
import { MarkdownMessage } from "../common/MarkdownMessage";
import { DiffView } from "../common/DiffView";
import {
  FileChangePreviewDialog,
  type FileChangePreviewItem,
} from "../common/FileChangePreviewDialog";
import { LinkifiedText } from "../common/LinkifiedText";
import {
  getStreamingText,
  getStreamingTextRevision,
  getStreamingTextTail,
  streamingProgressKey,
  streamingReasoningKey,
  subscribeStreamingText,
} from "../../streaming-text-store";
import {
  boundedStreamingReasoning,
  completedProcessDuration,
  completedProcessTextLength,
  groupActivitiesByTextOffset,
  shouldShowAssistantTailState,
  STREAMING_REASONING_DOM_CHAR_LIMIT,
  visibleAssistantContent,
} from "../../conversation-rendering";
import {
  getActivityOutput,
  getActivityOutputTail,
  subscribeActivityOutput,
} from "../../activity-output-store";
import {
  hydrateActivityPayload,
  type ActivityPayload,
} from "../../activity-payload";

const ACTIVITY_INITIAL_RENDER_LIMIT = 32;
const ACTIVITY_RENDER_PAGE_SIZE = 48;
const FILE_INITIAL_RENDER_LIMIT = 8;
const ACTIVITY_DETAIL_RENDER_LIMIT = 24_000;
const ACTIVITY_DETAIL_HEAD_CHARS = 4_000;
const STREAMING_DOM_CHAR_LIMIT = 96_000;
const STREAMING_DOM_TRIM_TARGET = 80_000;
const ACTIVITY_LIVE_OUTPUT_LIMIT = 24_000;

function renderedActivityDetail(detail: string) {
  if (detail.length <= ACTIVITY_DETAIL_RENDER_LIMIT)
    return { text: detail, omitted: 0 };
  const tailLength = ACTIVITY_DETAIL_RENDER_LIMIT - ACTIVITY_DETAIL_HEAD_CHARS;
  const omitted = detail.length - ACTIVITY_DETAIL_RENDER_LIMIT;
  return {
    text: `${detail.slice(0, ACTIVITY_DETAIL_HEAD_CHARS)}\n\n... 已省略中间 ${omitted.toLocaleString()} 个字符 ...\n\n${detail.slice(-tailLength)}`,
    omitted,
  };
}

function MessageItem({
  message,
  running,
  workspacePath,
  onRetry,
  attachments = [],
  assistantBody,
}: {
  message: ChatMessage;
  running: boolean;
  workspacePath: string;
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
  const error = message.error;
  const isError = Boolean(error);
  const visibleContent =
    message.role === "assistant"
      ? visibleAssistantContent(message.content)
      : message.content;
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
              onClick={() => void copyWithToast(visibleContent)}
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
          {message.role === "assistant" && assistantBody ? (
            assistantBody
          ) : visibleContent ? (
            message.role === "assistant" ? (
              <MarkdownMessage
                content={visibleContent}
                workspacePath={workspacePath}
              />
            ) : (
              visibleContent
            )
          ) : running ? (
            <div className="thinking">
              <span />
              <span />
              <span />
              正在思考
            </div>
          ) : null}
          {message.role === "assistant" &&
            message.completionResult &&
            ["incomplete", "blocked"].includes(
              message.completionResult.kind,
            ) && (
              <div
                className={`message-completion-notice ${message.completionResult.kind === "blocked" ? "is-blocked" : "is-paused"}`}
                role="status"
              >
                {message.completionResult.kind === "blocked" ? (
                  <CircleAlert size={14} />
                ) : (
                  <Clock3 size={14} />
                )}
                <span>
                  <strong>
                    {message.completionResult.kind === "blocked"
                      ? "等待补充信息"
                      : "已暂停，执行结果已保留"}
                  </strong>
                  {message.completionResult.notice && (
                    <small>{message.completionResult.notice}</small>
                  )}
                  <small className="message-completion-stats">
                    已执行 {message.completionResult.toolCalls} 项工具 · 成功{" "}
                    {message.completionResult.successfulTools} 项
                    {message.completionResult.failedTools > 0 &&
                      ` · 失败或停止 ${message.completionResult.failedTools} 项`}
                    {(message.completionResult.additions > 0 ||
                      message.completionResult.deletions > 0) &&
                      ` · +${message.completionResult.additions} -${message.completionResult.deletions}`}
                  </small>
                  {message.completionResult.changedFiles.length > 0 && (
                    <span className="message-completion-files">
                      <b>实际改动文件</b>
                      {message.completionResult.changedFiles
                        .slice(0, 8)
                        .map((file) => (
                          <code key={file} title={file}>
                            {file}
                          </code>
                        ))}
                      {message.completionResult.changedFiles.length > 8 && (
                        <em>
                          还有{" "}
                          {message.completionResult.changedFiles.length - 8} 个
                        </em>
                      )}
                    </span>
                  )}
                </span>
              </div>
            )}
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

const StreamingActivityOutputLeaf = memo(function StreamingActivityOutputLeaf({
  activityId,
}: {
  activityId: string;
}) {
  const nodeRef = React.useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const replace = (value: string) => {
      if (nodeRef.current)
        nodeRef.current.textContent =
          value.length > ACTIVITY_LIVE_OUTPUT_LIMIT
            ? value.slice(-ACTIVITY_LIVE_OUTPUT_LIMIT)
            : value;
    };
    replace(getActivityOutputTail(activityId, ACTIVITY_LIVE_OUTPUT_LIMIT));
    return subscribeActivityOutput(activityId, (change) => {
      if (change.type === "reset") replace("");
      else if (change.type === "replace") replace(change.value);
      else {
        const node = nodeRef.current;
        if (!node) return;
        node.textContent = `${node.textContent ?? ""}${change.value}`.slice(
          -ACTIVITY_LIVE_OUTPUT_LIMIT,
        );
      }
    });
  }, [activityId]);
  return <pre ref={nodeRef} className="activity-live-output" />;
});

const ActivityItem = memo(function ActivityItem({
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
  const [expanded, setExpanded] = useState(
    activity.status === "waiting" || activity.status === "running",
  );
  const [undoing, setUndoing] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(() =>
    Math.max(0, (activity.completedAt ?? Date.now()) - activity.startedAt),
  );
  const activityView = normalizeActivity(activity);
  const pending = activity.status === "waiting";
  const detail = activity.diff || activity.output;
  const rawReadableFailure =
    activity.errorSummary ||
    (activity.output && !/[\uFFFD]{1,}|[□�]{1,}/.test(activity.output)
      ? activity.output
      : activity.tool === "run_command"
        ? "命令执行失败，请查看详细输出。"
        : "工具执行失败，请查看详细输出。");
  const readableFailure =
    rawReadableFailure.length > 2_000
      ? `... ${rawReadableFailure.slice(-2_000)}`
      : rawReadableFailure;
  const renderedDetail =
    expanded && detail ? renderedActivityDetail(detail) : undefined;
  const executionNarrative = activityExecutionNarrative(activity);
  const liveOutput = activity.status === "running" && !detail;
  const executionModel =
    activity.agentRole === "executor" ? activityView.model : undefined;
  const revealPath = activityRevealPath(activity);
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
    <article
      className={`agent-activity ${activity.status} ${activity.recoverable ? "recoverable" : ""}`}
    >
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
          <span className="activity-title-line">
            <strong>{activity.title}</strong>
            {executionModel && (
              <span
                className="activity-model-badge"
                title={`由执行模型 ${executionModel} 执行${
                  activity.reasoningEffort
                    ? `，推理等级：${effortLabels[activity.reasoningEffort]}`
                    : ""
                }`}
              >
                <Cpu size={10} />
                {executionModel}
                {activity.reasoningEffort && (
                  <em>{effortLabels[activity.reasoningEffort]}</em>
                )}
              </span>
            )}
          </span>
          <small>
            {activity.command ||
              activity.path ||
              String(activity.input.name || "") ||
              String(activity.input.task || "") ||
              String(activity.input.agentId || "") ||
              String(activity.input.query || "") ||
              String(activity.input.branch || "") ||
              String(activity.input.remote || "")}
          </small>
        </span>
        {activity.additions !== undefined && (
          <span className="diff-count">
            <b>+{activity.additions}</b>
            <i>-{activity.deletions}</i>
          </span>
        )}
        {revealPath && (
          <button
            type="button"
            className="activity-reveal"
            title="在文件资源管理器中显示"
            aria-label={`在文件资源管理器中显示 ${revealPath}`}
            onClick={(event) => {
              event.stopPropagation();
              void revealLocalPath(revealPath, workspacePath);
            }}
          >
            <FolderOpen size={13} />
          </button>
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
        <span className="activity-status">{activityView.statusLabel}</span>
        <ChevronDown size={14} />
      </div>
      {expanded && (
        <div className="activity-detail">
          <div className="activity-purpose">
            <BrainCircuit size={14} />
            <span>
              <strong>执行说明</strong>
              <small>{executionNarrative}</small>
            </span>
          </div>
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
                  void window.kcode.chat.approveWithScope(
                    requestId,
                    activity.id,
                    true,
                    "once",
                    activity.command,
                    activity.permissionCategory,
                    workspacePath,
                  )
                }
              >
                允许
              </button>
              {activity.command && (
                <>
                  <button
                    className="allow session"
                    onClick={() =>
                      void window.kcode.chat.approveWithScope(
                        requestId,
                        activity.id,
                        true,
                        "session",
                        activity.command,
                        activity.permissionCategory,
                        workspacePath,
                      )
                    }
                  >
                    本次会话允许
                  </button>
                  <button
                    className="allow permanent"
                    onClick={() =>
                      void window.kcode.chat.approveWithScope(
                        requestId,
                        activity.id,
                        true,
                        "permanent",
                        activity.command,
                        activity.permissionCategory,
                        workspacePath,
                      )
                    }
                  >
                    永久允许
                  </button>
                </>
              )}
            </div>
          )}
          {activity.status === "failed" && (
            <div className="activity-error-reason">
              <CircleAlert size={14} />
              <span>
                <strong>
                  {activity.recoverable ? "访问受限" : "失败原因"}
                </strong>
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
                  {activity.liveStatus
                    ? activity.liveStatus
                    : activity.tool === "ssh_run"
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
          {(detail || liveOutput) && (
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
                  void copyWithToast(detail || getActivityOutput(activity.id));
                }}
              >
                <Copy size={12} />
                复制
              </button>
            </div>
          )}
          {renderedDetail?.omitted ? (
            <div className="activity-output-truncated">
              页面仅渲染首尾内容，中间已省略{" "}
              {renderedDetail.omitted.toLocaleString()}{" "}
              个字符；复制按钮仍会复制完整输出。
            </div>
          ) : null}
          {renderedDetail &&
            (activity.diff ? (
              <DiffView text={renderedDetail.text} />
            ) : (
              <pre>
                <LinkifiedText text={renderedDetail.text} />
              </pre>
            ))}
          {liveOutput && (
            <StreamingActivityOutputLeaf activityId={activity.id} />
          )}
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
});

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
  "ssh_download_file",
];
const localPathTools = new Set<AgentToolName>([
  "list_directory",
  "glob_files",
  "read_many_files",
  "path_info",
  "read_file",
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "git_diff",
  "git_show",
  "browser_screenshot",
  "ssh_download_file",
]);
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

function activityRevealPath(activity: AgentActivity) {
  if (
    !activity.path ||
    !localPathTools.has(activity.tool) ||
    (activity.status !== "success" && activity.status !== "completed")
  )
    return undefined;
  return activity.path;
}

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

type FileChangeStats = {
  additions: number;
  deletions: number;
  diffs: string[];
  revealable: boolean;
};

function collectFileChangeStats(activities: AgentActivity[]) {
  const grouped = new Map<string, FileChangeStats>();
  for (const activity of activities) {
    if (
      !fileTools.includes(activity.tool) ||
      activity.status !== "success" ||
      activity.undone
    )
      continue;
    for (const change of activityFileChanges(activity)) {
      const current = grouped.get(change.path) ?? {
        additions: 0,
        deletions: 0,
        diffs: [],
        revealable: false,
      };
      current.additions += change.additions;
      current.deletions += change.deletions;
      if (change.diff) current.diffs.push(change.diff);
      current.revealable ||= Boolean(activityRevealPath(activity));
      grouped.set(change.path, current);
    }
  }
  const entries = [...grouped.entries()];
  return {
    grouped,
    entries,
    files: grouped.size,
    additions: entries.reduce((sum, [, item]) => sum + item.additions, 0),
    deletions: entries.reduce((sum, [, item]) => sum + item.deletions, 0),
  };
}

function ExecutionFileBreakdown({
  fileStats,
  entries,
  workspacePath,
  compact = false,
}: {
  fileStats: ReturnType<typeof collectFileChangeStats>;
  entries: [string, FileChangeStats][];
  workspacePath: string;
  compact?: boolean;
}) {
  const [previewFile, setPreviewFile] = useState<string>();
  const previewItems: FileChangePreviewItem[] = useMemo(
    () =>
      entries.map(([path, stats]) => ({
        path,
        diff: stats.diffs.join("\n\n"),
        additions: stats.additions,
        deletions: stats.deletions,
        revealable: stats.revealable,
      })),
    [entries],
  );
  const visibleEntries = entries.slice(
    0,
    compact ? 4 : FILE_INITIAL_RENDER_LIMIT,
  );
  if (!entries.length) return null;
  return (
    <>
      <div
        className={`execution-summary-file-breakdown ${compact ? "compact" : ""}`}
        aria-label="本轮文件改动"
      >
        <header>
          <strong>文件改动</strong>
          <small>
            {fileStats.files} 个文件 · +{fileStats.additions} -
            {fileStats.deletions}
          </small>
        </header>
        {visibleEntries.map(([file, stats]) => {
          const hasDiff = stats.diffs.length > 0;
          return (
            <div className="execution-summary-file-item" key={file}>
              <div
                className={`execution-summary-file-row-wrap ${stats.revealable ? "revealable" : ""}`}
              >
                <button
                  type="button"
                  className={`execution-summary-file-row ${hasDiff ? "" : "no-diff"}`}
                  aria-haspopup={hasDiff ? "dialog" : undefined}
                  aria-label={
                    hasDiff ? `查看 ${file} 的改动` : `${file} 没有差异详情`
                  }
                  title={hasDiff ? "点击查看改动" : "此改动没有可显示的差异"}
                  onClick={() => hasDiff && setPreviewFile(file)}
                >
                  {hasDiff ? (
                    <ChevronRight size={12} />
                  ) : (
                    <FileCode2 size={12} />
                  )}
                  <code title={file}>{file}</code>
                  <span>
                    <b>+{stats.additions}</b>
                    <i>-{stats.deletions}</i>
                  </span>
                </button>
                {stats.revealable && (
                  <button
                    type="button"
                    className="execution-summary-file-reveal"
                    title="在文件资源管理器中显示"
                    aria-label={`在文件资源管理器中显示 ${file}`}
                    onClick={() => void revealLocalPath(file, workspacePath)}
                  >
                    <FolderOpen size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {fileStats.files > visibleEntries.length && (
          <footer>
            还有 {fileStats.files - visibleEntries.length}{" "}
            个文件，点击任一文件后可在弹窗中切换
          </footer>
        )}
      </div>
      {previewFile && (
        <FileChangePreviewDialog
          files={previewItems}
          selectedPath={previewFile}
          workspacePath={workspacePath}
          onSelectPath={setPreviewFile}
          onClose={() => setPreviewFile(undefined)}
        />
      )}
    </>
  );
}

function activeExecutionCopy(activity: AgentActivity) {
  const target =
    activity.command || activity.path || activityTarget(activity) || "";
  switch (activity.tool) {
    case "run_command":
      return { label: "正在运行命令", target };
    case "ssh_run":
      return { label: "正在运行远程命令", target };
    case "mysql_query":
    case "sqlserver_query":
    case "mongodb_execute":
      return { label: "正在执行查询", target };
    case "apply_patch":
      return { label: "正在应用修改", target };
    case "write_file":
    case "ssh_write_file":
      return { label: "正在写入文件", target };
    case "move_path":
      return { label: "正在移动文件", target };
    case "delete_path":
      return { label: "正在删除文件", target };
    case "diagnostics":
      return { label: "正在检查诊断", target };
    default:
      return { label: `正在${activity.title}`, target };
  }
}

function executorEvidence(activities: readonly AgentActivity[]) {
  const executed = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.agentRole === "executor" &&
        Boolean(activity.modelDisplayName || activity.modelId),
    );
  if (executed)
    return {
      model: executed.modelDisplayName || executed.modelId || "执行模型",
      effort: executed.reasoningEffort,
      executed: true,
    };
  const dispatched = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.tool === "spawn_agent" &&
        typeof activity.input.model === "string" &&
        activity.input.model,
    );
  if (!dispatched) return undefined;
  return {
    model: String(dispatched.input.model),
    effort: undefined,
    executed: false,
  };
}

function PlanStepMark({
  status,
  index,
}: {
  status: ExecutionPlanStepStatus;
  index: number;
}) {
  if (status === "completed") return <CheckCircle2 size={13} />;
  if (status === "failed") return <CircleAlert size={13} />;
  if (status === "running")
    return <LoaderCircle className="execution-plan-spinner" size={13} />;
  return <span>{index + 1}</span>;
}

function ExecutionPlanList({
  steps,
  current,
  statuses,
}: {
  steps: string[];
  current: number;
  statuses: ExecutionPlanStepStatus[];
}) {
  return (
    <div className="execution-plan-list">
      <header>
        <span>
          <ListChecks size={13} />
          <strong>执行计划</strong>
        </span>
        <small>
          第 {current + 1} / {steps.length} 步
        </small>
      </header>
      {steps.map((step, index) => (
        <div
          className={`execution-plan-step ${statuses[index]} ${index === current ? "current" : ""}`}
          key={`${index}:${step}`}
        >
          <span className="execution-plan-step-mark">
            <PlanStepMark status={statuses[index]} index={index} />
          </span>
          <span className="execution-plan-step-copy">
            <strong>{step}</strong>
            <small>
              {statuses[index] === "completed"
                ? "已完成"
                : statuses[index] === "running"
                  ? "执行中"
                  : statuses[index] === "failed"
                    ? "失败，正在调整"
                    : "待执行"}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

export const ExecutionSummary = memo(
  function ExecutionSummary({
    activities,
    allActivities,
    running,
    isLatestGroup,
    requestFailed,
    hasLeadingNarration,
    hasTrailingNarration,
    requestId,
    workspacePath,
    onActivityChange,
    reasoningNode,
  }: {
    activities: AgentActivity[];
    allActivities: AgentActivity[];
    running: boolean;
    isLatestGroup: boolean;
    requestFailed: boolean;
    hasLeadingNarration: boolean;
    hasTrailingNarration: boolean;
    requestId?: string;
    workspacePath: string;
    onActivityChange(activity: AgentActivity): void;
    reasoningNode?: React.ReactNode;
  }) {
    const [expanded, setExpanded] = useState(false);
    const [deferredPayloads, setDeferredPayloads] = useState<
      Record<string, ActivityPayload | null>
    >({});
    const [payloadsLoading, setPayloadsLoading] = useState(false);
    const [visibleActivityCount, setVisibleActivityCount] = useState(
      ACTIVITY_INITIAL_RENDER_LIMIT,
    );
    useEffect(() => {
      const pending = activities.filter(
        (activity) =>
          activity.payloadStored && !(activity.id in deferredPayloads),
      );
      if (!pending.length || !window.kcode?.state.loadActivityPayload) return;
      let active = true;
      setPayloadsLoading(true);
      void Promise.all(
        pending.map(
          async (activity) =>
            [
              activity.id,
              (await window.kcode.state.loadActivityPayload(
                activity.id,
              )) as ActivityPayload | null,
            ] as const,
        ),
      )
        .then((items) => {
          if (!active) return;
          setDeferredPayloads((current) => ({
            ...current,
            ...Object.fromEntries(items),
          }));
        })
        .finally(() => active && setPayloadsLoading(false));
      return () => {
        active = false;
      };
    }, [activities, deferredPayloads]);
    const displayActivities = useMemo(
      () =>
        activities.map((activity) =>
          hydrateActivityPayload(activity, deferredPayloads[activity.id]),
        ),
      [activities, deferredPayloads],
    );
    const fileStats = useMemo(
      () => collectFileChangeStats(displayActivities),
      [displayActivities],
    );
    const planInfo = useMemo(
      () => summarizeExecutionPlan(allActivities),
      [allActivities],
    );
    const inlineActivities = displayActivities.slice(-4);
    // Recomputing these passes on every streaming flush is wasted work; the
    // result only changes when the activity set changes.
    const executionStats = useMemo(
      () => summarizeActivities(displayActivities),
      [displayActivities],
    );
    const executor = useMemo(
      () => executorEvidence(displayActivities),
      [displayActivities],
    );
    const activeRunning =
      running && executionStats.active?.status === "running";
    const executionInProgress = activeRunning;
    let headline = "执行完成";
    let focus = "";
    if (executionStats.waiting && executionStats.active) {
      headline = "等待确认";
      focus = activityFocus(executionStats.active);
    } else if (activeRunning && executionStats.active) {
      const copy = activeExecutionCopy(executionStats.active);
      headline = copy.label;
      focus = copy.target;
    } else if (requestFailed) {
      headline = "执行未完成";
    } else if (executionStats.failures) {
      headline =
        running && !hasTrailingNarration
          ? "步骤失败"
          : "执行完成，已记录失败项";
    } else if (executionStats.limited) {
      headline = running ? "访问受限，正在切换方案" : "已降级完成";
    } else if (executionStats.commands) {
      headline = `已执行 ${executionStats.commands} 个命令`;
    } else if (displayActivities.length) {
      headline = `已完成 ${displayActivities.length} 个步骤`;
    }
    useEffect(() => {
      if (executionStats.waiting) setExpanded(true);
    }, [executionStats.waiting]);
    useEffect(() => {
      if (!expanded) setVisibleActivityCount(ACTIVITY_INITIAL_RENDER_LIMIT);
    }, [expanded]);
    if (!displayActivities.length) return null;
    const hiddenActivityCount = Math.max(
      0,
      displayActivities.length - visibleActivityCount,
    );
    const visibleActivities = displayActivities.slice(hiddenActivityCount);
    const showPlanList = Boolean(
      isLatestGroup &&
      planInfo &&
      (running || Boolean(executionStats.active) || expanded),
    );
    const fallbackNarrative = executionStats.active
      ? hasLeadingNarration
        ? ""
        : activityExecutionNarrative(executionStats.active)
      : "";
    const narrativeLabel = "执行说明";
    return (
      <section
        className={`execution-summary ${fileStats.files ? "has-file-stats" : ""} ${requestFailed ? "has-failures" : ""} ${executionStats.limited ? "has-limits" : ""} ${executionInProgress ? "is-active" : ""} ${executionStats.waiting ? "is-waiting" : ""}`}
      >
        <button
          className="execution-summary-head"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="execution-summary-icon">
            {executionInProgress && !executionStats.active ? (
              <BrainCircuit size={15} />
            ) : executionStats.active &&
              fileTools.includes(executionStats.active.tool) ? (
              <FileCode2 size={15} />
            ) : executionStats.active &&
              subagentTools.includes(executionStats.active.tool) ? (
              <Bot size={15} />
            ) : (
              <Terminal size={15} />
            )}
          </span>
          <span className="execution-summary-copy">
            <strong aria-live="polite">
              <span>{headline}</span>
              {focus && <code title={focus}>{focus}</code>}
            </strong>
            <small className="execution-summary-statline">
              {executionStats.commands > 0 && (
                <span>{executionStats.commands} 个命令</span>
              )}
              {executionStats.agents > 0 && (
                <span>{executionStats.agents} 个子 Agent</span>
              )}
              {executor && (
                <span
                  className={`execution-summary-executor ${
                    executor.executed ? "verified" : "dispatched"
                  }`}
                  title={
                    executor.executed
                      ? "已收到该执行模型的真实工具活动"
                      : "执行模型已派发，正在等待工具活动"
                  }
                >
                  <Cpu size={10} />
                  {executor.model}
                  {executor.effort && ` · ${effortLabels[executor.effort]}`}
                  {executor.executed ? " 执行" : " 已派发"}
                </span>
              )}
              {isLatestGroup && planInfo && (
                <span className="execution-summary-plan-count">
                  第 {planInfo.current + 1} / {planInfo.steps.length} 步
                </span>
              )}
              {fileStats.files > 0 && <span>{fileStats.files} 个文件</span>}
              {fileStats.files > 0 && (
                <span className="execution-summary-diff">
                  <b>+{fileStats.additions}</b>
                  <i>-{fileStats.deletions}</i>
                </span>
              )}
              {!executionStats.commands &&
                !executionStats.agents &&
                !fileStats.files && (
                  <span>{displayActivities.length} 个步骤</span>
                )}
              {executionStats.failures > 0 && (
                <span className="execution-summary-failures">
                  {executionStats.failures} 项失败
                </span>
              )}
              {executionStats.limited > 0 && (
                <span className="execution-summary-limits">
                  {executionStats.limited} 项访问受限
                </span>
              )}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        {inlineActivities.length > 0 && (
          <div className="execution-summary-toolline" aria-label="本组执行命令">
            {inlineActivities.map((activity) => {
              const target = activityTarget(activity);
              return (
                <span
                  className={`execution-summary-tool ${activity.status} ${activity.recoverable ? "recoverable" : ""}`}
                  key={activity.id}
                  title={target || activity.title}
                >
                  <i />
                  <b>{activity.title}</b>
                  {activity.agentRole === "executor" &&
                    (activity.modelDisplayName || activity.modelId) && (
                      <em className="execution-summary-tool-model">
                        <Cpu size={9} />
                        {activity.modelDisplayName || activity.modelId}
                        {activity.reasoningEffort &&
                          ` · ${effortLabels[activity.reasoningEffort]}`}
                      </em>
                    )}
                  {target && <code>{target}</code>}
                </span>
              );
            })}
            {displayActivities.length > inlineActivities.length && (
              <small>
                还有 {displayActivities.length - inlineActivities.length} 项
              </small>
            )}
          </div>
        )}
        {isLatestGroup && planInfo && !showPlanList && (
          <div className="execution-plan-progress">
            <span>
              <ListChecks size={12} />第 {planInfo.current + 1} /{" "}
              {planInfo.steps.length} 步
            </span>
            <strong>{planInfo.steps[planInfo.current]}</strong>
          </div>
        )}
        {showPlanList && planInfo && (
          <ExecutionPlanList
            steps={planInfo.steps}
            current={planInfo.current}
            statuses={planInfo.statuses}
          />
        )}
        {running &&
          executionStats.active &&
          (fallbackNarrative || reasoningNode) && (
            <div
              className={`execution-summary-narrative ${fallbackNarrative ? "" : "live-only"}`}
              aria-live="polite"
            >
              <span className="execution-summary-narrative-label">
                {narrativeLabel}
              </span>
              <span className="execution-summary-narrative-copy">
                {reasoningNode}
                {fallbackNarrative && (
                  <span className="execution-summary-narrative-fallback">
                    {fallbackNarrative}
                  </span>
                )}
              </span>
            </div>
          )}
        {!expanded && fileStats.entries.length > 0 && (
          <ExecutionFileBreakdown
            fileStats={fileStats}
            entries={fileStats.entries}
            workspacePath={workspacePath}
            compact
          />
        )}
        {expanded && (
          <div className="execution-summary-detail">
            <div className="execution-summary-detail-head">
              <strong>执行明细</strong>
              <small>
                {displayActivities.length} 个步骤 · {executionStats.completed}{" "}
                已完成
                {payloadsLoading ? " · 正在加载完整输出" : ""}
              </small>
            </div>
            {hiddenActivityCount > 0 && (
              <button
                type="button"
                className="execution-history-more"
                onClick={() =>
                  setVisibleActivityCount((count) =>
                    Math.min(
                      displayActivities.length,
                      count + ACTIVITY_RENDER_PAGE_SIZE,
                    ),
                  )
                }
              >
                显示更早的{" "}
                {Math.min(ACTIVITY_RENDER_PAGE_SIZE, hiddenActivityCount)}{" "}
                个步骤
                <small>还有 {hiddenActivityCount} 个未渲染</small>
              </button>
            )}
            {visibleActivities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                requestId={requestId}
                workspacePath={workspacePath}
                onActivityChange={onActivityChange}
              />
            ))}
            <ExecutionFileBreakdown
              fileStats={fileStats}
              entries={fileStats.entries}
              workspacePath={workspacePath}
            />
          </div>
        )}
      </section>
    );
  },
  (prev, next) => {
    if (
      prev.running !== next.running ||
      prev.isLatestGroup !== next.isLatestGroup ||
      prev.requestFailed !== next.requestFailed ||
      prev.hasLeadingNarration !== next.hasLeadingNarration ||
      prev.hasTrailingNarration !== next.hasTrailingNarration ||
      prev.requestId !== next.requestId ||
      prev.workspacePath !== next.workspacePath ||
      prev.onActivityChange !== next.onActivityChange ||
      prev.activities.length !== next.activities.length ||
      prev.allActivities.length !== next.allActivities.length
    )
      return false;
    if (
      !prev.activities.every(
        (activity, index) => activity === next.activities[index],
      )
    )
      return false;
    return prev.allActivities.every(
      (activity, index) => activity === next.allActivities[index],
    );
  },
);

function AgentWorkingState({
  activities,
  hasTrailingText,
  reasoning,
  reasoningNode,
}: {
  activities: AgentActivity[];
  hasTrailingText: boolean;
  reasoning?: string;
  reasoningNode?: React.ReactNode;
}) {
  const visible = activities.length === 0 && !hasTrailingText;
  // Once a tool exists, the execution summary owns the whole run, including
  // planning gaps between tools. A second indicator below it would duplicate the
  // completed step and make the request look like two independent processes.
  // Pure Q&A also drops this planning state as soon as answer text appears.
  if (!visible) return null;
  return (
    <div className="agent-working">
      <div className="agent-working-head" aria-live="polite">
        <span className="agent-working-mark">
          <BrainCircuit size={13} />
        </span>
        <span className="agent-working-copy">
          <strong>正在规划下一步</strong>
        </span>
      </div>
      {(reasoning || reasoningNode) && (
        <div
          className="agent-working-reasoning"
          aria-live="polite"
          data-has-static={reasoning ? "true" : "false"}
        >
          {reasoning}
          {reasoningNode}
        </div>
      )}
    </div>
  );
}

function AssistantTailState({
  reasoningNode,
  progressNode,
}: {
  reasoningNode?: React.ReactNode;
  progressNode?: React.ReactNode;
}) {
  if (!reasoningNode && !progressNode) return null;
  return (
    <div className="assistant-tail-state" aria-live="polite">
      <BrainCircuit size={12} />
      <span className="assistant-tail-copy">
        {reasoningNode}
        {progressNode}
        <span className="assistant-tail-fallback">正在继续执行…</span>
      </span>
    </div>
  );
}

function CompletedProcessDisclosure({
  durationMs,
  failed,
  paused = false,
  blocked = false,
  activities,
  children,
}: {
  durationMs: number;
  failed: boolean;
  paused?: boolean;
  blocked?: boolean;
  activities: AgentActivity[];
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const fileStats = useMemo(
    () => collectFileChangeStats(activities),
    [activities],
  );
  const executor = useMemo(() => executorEvidence(activities), [activities]);
  return (
    <section
      className={`completed-process ${expanded ? "expanded" : ""} ${
        failed ? "failed" : ""
      } ${paused ? "paused" : ""} ${blocked ? "blocked" : ""}`}
    >
      <button
        type="button"
        className="completed-process-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="completed-process-state">
          {blocked ? (
            <CircleAlert size={13} />
          ) : paused ? (
            <Clock3 size={13} />
          ) : failed ? (
            <CircleAlert size={13} />
          ) : (
            <CheckCircle2 size={13} />
          )}
          <strong>
            {blocked
              ? "等待输入"
              : paused
                ? "已暂停"
                : failed
                  ? "处理未完成"
                  : "已处理"}
          </strong>
          <time>{formatCompactDuration(durationMs)}</time>
        </span>
        <span className="completed-process-metrics">
          {activities.length > 0 && <span>{activities.length} 个步骤</span>}
          {fileStats.files > 0 && <span>{fileStats.files} 个文件</span>}
          {fileStats.files > 0 && (
            <span className="completed-process-diff">
              <b>+{fileStats.additions}</b>
              <i>-{fileStats.deletions}</i>
            </span>
          )}
          {executor && (
            <span className="completed-process-executor" title={executor.model}>
              <Cpu size={10} />
              {executor.model}
            </span>
          )}
        </span>
        <ChevronRight className="completed-process-chevron" size={13} />
      </button>
      {expanded && <div className="completed-process-body">{children}</div>}
    </section>
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
  streamingTail,
  streamingReasoning,
  streamingProgress,
}: {
  message: ChatMessage;
  activities: AgentActivity[];
  running: boolean;
  requestId?: string;
  workspacePath: string;
  onActivityChange(activity: AgentActivity): void;
  reasoning?: string;
  streamingTail?: React.ReactNode;
  streamingReasoning?: React.ReactNode;
  streamingProgress?: React.ReactNode;
}) {
  const renderText = (text: string, intermediate = false) => {
    const visible = visibleAssistantContent(text);
    if (!visible) return null;
    const display = intermediate ? executionNarrativePreview(visible) : visible;
    if (!display) return null;
    // Persisted segments are stable and can be Markdown. The currently growing
    // tail stays append-only until it settles, avoiding repeated DOM replacement
    // and line-height changes while the viewport follows the bottom.
    if (running && intermediate)
      return (
        <div className="streaming-message-text execution-narration-preview">
          {display}
        </div>
      );
    return <MarkdownMessage content={display} workspacePath={workspacePath} />;
  };
  const hasActiveActivity = activities.some(
    (activity) =>
      activity.status === "running" || activity.status === "waiting",
  );
  const storedFinalResponseOffset = Number(message.finalResponseOffset);
  const finalResponseOffset = Number.isFinite(storedFinalResponseOffset)
    ? Math.min(
        message.content.length,
        Math.max(0, Math.floor(storedFinalResponseOffset)),
      )
    : undefined;
  const paused = message.completionResult?.kind === "incomplete";
  const blocked = message.completionResult?.kind === "blocked";
  if (!activities.length) {
    if (
      message.finalResponseProcess === "correction" &&
      finalResponseOffset !== undefined &&
      finalResponseOffset > 0
    ) {
      const processNode = renderText(
        message.content.slice(0, finalResponseOffset),
      );
      const finalNode = renderText(message.content.slice(finalResponseOffset));
      return (
        <div className="assistant-timeline">
          <CompletedProcessDisclosure
            durationMs={completedProcessDuration(
              message.createdAt,
              message.completedAt ?? message.finalResponseStartedAt,
              activities,
            )}
            failed={Boolean(message.error)}
            paused={paused}
            blocked={blocked}
            activities={activities}
          >
            {processNode}
          </CompletedProcessDisclosure>
          {finalNode}
          {streamingTail}
        </div>
      );
    }
    return (
      <>
        {renderText(message.content)}
        {streamingTail}
        {running && (
          <AgentWorkingState
            activities={activities}
            hasTrailingText={Boolean(message.content)}
            reasoning={reasoning}
            reasoningNode={streamingReasoning}
          />
        )}
      </>
    );
  }
  const processFinished = !running || finalResponseOffset !== undefined;
  const processRunning = running && !processFinished;
  const processTextLength = processFinished
    ? (finalResponseOffset ??
      completedProcessTextLength(activities, message.content.length))
    : message.content.length;
  const timelineGroups = groupActivitiesByTextOffset(
    activities,
    processTextLength,
  );
  const timelineNodes: React.ReactNode[] = [];
  let textCursor = 0;
  timelineGroups.forEach((group, index) => {
    const leadingText = message.content.slice(textCursor, group.offset);
    const nextOffset = timelineGroups[index + 1]?.offset ?? processTextLength;
    const followingText = message.content.slice(group.offset, nextOffset);
    const leadingNode = renderText(leadingText, true);
    if (leadingNode)
      timelineNodes.push(
        <React.Fragment key={`text:${group.activities[0].id}`}>
          {leadingNode}
        </React.Fragment>,
      );
    timelineNodes.push(
      <div
        className="assistant-timeline-group"
        key={`activities:${group.activities[0].id}`}
      >
        <ExecutionSummary
          activities={group.activities}
          allActivities={activities}
          running={processRunning}
          isLatestGroup={index === timelineGroups.length - 1}
          requestFailed={
            index === timelineGroups.length - 1 && Boolean(message.error)
          }
          hasLeadingNarration={Boolean(
            visibleAssistantContent(leadingText).trim(),
          )}
          hasTrailingNarration={Boolean(
            visibleAssistantContent(followingText).trim(),
          )}
          requestId={processRunning ? requestId : undefined}
          workspacePath={workspacePath}
          onActivityChange={onActivityChange}
          reasoningNode={
            index === timelineGroups.length - 1 &&
            processRunning &&
            hasActiveActivity
              ? streamingReasoning
              : undefined
          }
        />
      </div>,
    );
    textCursor = group.offset;
  });
  const trailingNode = renderText(
    message.content.slice(processFinished ? processTextLength : textCursor),
  );
  if (processFinished)
    return (
      <div className="assistant-timeline">
        <CompletedProcessDisclosure
          durationMs={completedProcessDuration(
            message.createdAt,
            message.completedAt ?? message.finalResponseStartedAt,
            activities,
          )}
          failed={Boolean(message.error)}
          paused={paused}
          blocked={blocked}
          activities={activities}
        >
          {timelineNodes}
        </CompletedProcessDisclosure>
        {trailingNode}
        {streamingTail}
      </div>
    );
  if (trailingNode)
    timelineNodes.push(
      <React.Fragment key="text:trailing">{trailingNode}</React.Fragment>,
    );
  return (
    <div className="assistant-timeline">
      {timelineNodes}
      {streamingTail}
      {shouldShowAssistantTailState(running) && (
        <AssistantTailState
          reasoningNode={hasActiveActivity ? undefined : streamingReasoning}
          progressNode={streamingProgress}
        />
      )}
    </div>
  );
});

const StreamingTextLeaf = memo(function StreamingTextLeaf({
  requestId,
  offset,
  revision,
}: {
  requestId: string;
  offset: number;
  revision: number;
}) {
  const nodeRef = React.useRef<HTMLDivElement>(null);
  const tailNodeRef = React.useRef<Text | null>(null);
  const renderedCharsRef = React.useRef(0);
  useLayoutEffect(() => {
    const replaceText = (value: string) => {
      const node = nodeRef.current;
      if (!node) return;
      const visible =
        value.length > STREAMING_DOM_CHAR_LIMIT
          ? value.slice(-STREAMING_DOM_TRIM_TARGET)
          : value;
      node.textContent = visible;
      renderedCharsRef.current = visible.length;
      if (visible.length < value.length) node.dataset.truncated = "true";
      else delete node.dataset.truncated;
      // Never append into an arbitrarily large initial node. Subsequent live
      // output starts in a bounded tail node so shaping/layout stays local.
      tailNodeRef.current = null;
    };
    const trimRenderedText = () => {
      const node = nodeRef.current;
      if (!node || renderedCharsRef.current <= STREAMING_DOM_CHAR_LIMIT) return;
      let removeCount = renderedCharsRef.current - STREAMING_DOM_TRIM_TARGET;
      while (removeCount > 0 && node.firstChild) {
        const first = node.firstChild;
        if (!(first instanceof Text)) {
          first.remove();
          continue;
        }
        if (first.data.length <= removeCount) {
          removeCount -= first.data.length;
          renderedCharsRef.current -= first.data.length;
          if (first === tailNodeRef.current) tailNodeRef.current = null;
          first.remove();
        } else {
          first.deleteData(0, removeCount);
          renderedCharsRef.current -= removeCount;
          removeCount = 0;
        }
      }
      node.dataset.truncated = "true";
    };
    const appendText = (delta: string) => {
      const node = nodeRef.current;
      if (!node || !delta) return;
      let tail = tailNodeRef.current;
      if (!tail || !tail.isConnected || tail.data.length >= 512) {
        tail = document.createTextNode("");
        node.append(tail);
        tailNodeRef.current = tail;
      }
      tail.appendData(delta);
      renderedCharsRef.current += delta.length;
      trimRenderedText();
    };
    const snapshot = getStreamingTextTail(requestId, STREAMING_DOM_CHAR_LIMIT);
    const snapshotStart = Math.max(
      0,
      snapshot.totalLength - snapshot.text.length,
    );
    const initial = snapshot.text.slice(Math.max(0, offset - snapshotStart));
    replaceText(initial);
    return subscribeStreamingText(requestId, (change) => {
      if (change.type === "reset") replaceText("");
      else if (change.type === "replace") replaceText(change.value);
      else appendText(change.delta);
    });
  }, [offset, requestId, revision]);
  return <div ref={nodeRef} className="streaming-message-text" />;
});

const StreamingReasoningLeaf = memo(function StreamingReasoningLeaf({
  requestId,
}: {
  requestId: string;
}) {
  const nodeRef = React.useRef<HTMLSpanElement>(null);
  const textNodeRef = React.useRef<Text | null>(null);
  useLayoutEffect(() => {
    const key = streamingReasoningKey(requestId);
    const ensureTextNode = () => {
      const node = nodeRef.current;
      if (!node) return undefined;
      if (!textNodeRef.current) {
        textNodeRef.current = document.createTextNode("");
        node.replaceChildren(textNodeRef.current);
      }
      return textNodeRef.current;
    };
    const replaceText = (value: string, alreadyTruncated = false) => {
      const target = ensureTextNode();
      const node = nodeRef.current;
      if (!target || !node) return;
      const bounded = boundedStreamingReasoning(value);
      target.data = bounded.text;
      node.hidden = !bounded.text;
      if (bounded.truncated || alreadyTruncated)
        node.dataset.truncated = "true";
      else delete node.dataset.truncated;
    };
    const appendText = (delta: string) => {
      const target = ensureTextNode();
      const node = nodeRef.current;
      if (!target || !node || !delta) return;
      target.appendData(delta);
      if (target.length > STREAMING_REASONING_DOM_CHAR_LIMIT) {
        const bounded = boundedStreamingReasoning(target.data);
        target.data = bounded.text;
        node.dataset.truncated = "true";
      }
      node.hidden = false;
    };
    const initial = getStreamingTextTail(
      key,
      STREAMING_REASONING_DOM_CHAR_LIMIT,
    );
    replaceText(initial.text, initial.totalLength > initial.text.length);
    return subscribeStreamingText(key, (change) => {
      if (change.type === "reset") {
        replaceText("");
      } else if (change.type === "replace") {
        replaceText(change.value);
      } else appendText(change.delta);
    });
  }, [requestId]);
  return <span ref={nodeRef} className="streaming-status-leaf" hidden />;
});

const StreamingProgressLeaf = memo(function StreamingProgressLeaf({
  requestId,
}: {
  requestId: string;
}) {
  const nodeRef = React.useRef<HTMLSpanElement>(null);
  const textNodeRef = React.useRef<Text | null>(null);
  useLayoutEffect(() => {
    const key = streamingProgressKey(requestId);
    const ensureTextNode = () => {
      const node = nodeRef.current;
      if (!node) return undefined;
      if (!textNodeRef.current) {
        textNodeRef.current = document.createTextNode("");
        node.replaceChildren(textNodeRef.current);
      }
      return textNodeRef.current;
    };
    const textNode = ensureTextNode();
    const initial = getStreamingText(key);
    if (textNode) textNode.data = initial;
    if (nodeRef.current) nodeRef.current.hidden = !initial;
    return subscribeStreamingText(key, (change) => {
      const target = ensureTextNode();
      if (!target) return;
      if (change.type === "reset") {
        target.data = "";
        if (nodeRef.current) nodeRef.current.hidden = true;
      } else if (change.type === "replace") {
        target.data = change.value;
        if (nodeRef.current) nodeRef.current.hidden = !change.value;
      } else {
        target.appendData(change.delta);
        if (nodeRef.current && change.delta) nodeRef.current.hidden = false;
      }
    });
  }, [requestId]);
  return (
    <span
      ref={nodeRef}
      className="streaming-status-leaf streaming-progress-leaf"
      hidden
    />
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
  // StreamingTextLeaf mutates one bounded text node. Do not periodically move
  // that text into React/Markdown: doing so replaces the live DOM, changes its
  // measured height, and makes bottom-follow visibly bounce. Tool boundaries
  // and completion already persist the segment and render Markdown once.
  const streamingRevision = running ? getStreamingTextRevision(requestId) : 0;
  return (
    <AssistantTimeline
      message={message}
      activities={activities}
      running={running}
      requestId={running ? requestId : undefined}
      workspacePath={workspacePath}
      onActivityChange={onActivityChange}
      reasoning={reasoning}
      streamingReasoning={
        running ? <StreamingReasoningLeaf requestId={requestId} /> : undefined
      }
      streamingProgress={
        running ? <StreamingProgressLeaf requestId={requestId} /> : undefined
      }
      streamingTail={
        running ? (
          <StreamingTextLeaf
            requestId={requestId}
            offset={0}
            revision={streamingRevision}
          />
        ) : undefined
      }
    />
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
        className={`conversation-turn-item ${running ? "running" : "complete"}`}
        ref={message.role === "user" ? turnRef : undefined}
      >
        <MessageItem
          message={message}
          running={running}
          workspacePath={workspacePath}
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
    olderMessagesLoading,
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
    olderMessagesLoading: boolean;
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
          <div
            className={`conversation-history-loader ${olderMessagesLoading ? "loading" : ""}`}
            aria-live="polite"
          >
            <span />
            {olderMessagesLoading ? "正在加载更早对话" : "向上滚动加载更早对话"}
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
    if (prev.olderMessagesLoading !== next.olderMessagesLoading) return false;
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
