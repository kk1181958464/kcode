import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  CloudOff,
  Columns2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCode2,
  GitCompareArrows,
  Minimize2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Undo2,
  SquareSplitVertical,
  Terminal,
  TextWrap,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONTEXT_AUTO_COMPACT_RATIO } from "../../context";
import { extractGitFileDiff } from "../../git-diff";
import { normalizeActivity } from "../../activity-view-model";
import { activityTarget, formatDuration, workingPhase } from "../../lib/format";
import type { TaskRecord } from "../../models";
import {
  buildAgentOverviewBoard,
  type AgentOverviewRow,
  type AgentOverviewTaskInput,
} from "../../agent-overview";
import { localWorkspacePath } from "../../task-workspace";
import {
  summarizeStatusActivities,
  statusHeadline,
  statusOverviewTone,
  type StatusFileChange,
} from "../../status-summary";
import type { TaskRunStatus } from "../../task-status";
import type {
  AgentActivity,
  AgentCheckpoint,
  ChatMessage,
  EditCheckpointInfo,
  GitWorkspaceState,
  ModelConfig,
  ProviderConfig,
  ReasoningEffort,
} from "../../types";
import { DiffView } from "../common/DiffView";

interface UsageInfo {
  input: number;
  output: number;
  cached: number;
  promptTokens?: number;
}

interface ModelEntry {
  provider: ProviderConfig;
  model: ModelConfig;
}

export interface StatusPanelProps {
  runStatus: TaskRunStatus;
  activities: AgentActivity[];
  selectedTarget: ModelEntry | undefined;
  executorTarget?: ModelEntry;
  effortLabels: Record<ReasoningEffort, string>;
  reasoningEffort: ReasoningEffort;
  checkpoints: AgentCheckpoint[];
  activeTask: TaskRecord | undefined;
  runningId: string | undefined;
  summaryBusy: boolean;
  resumeCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  editCheckpoints?: EditCheckpointInfo[];
  keepFileChanges?(paths?: string[]): Promise<void> | void;
  undoFileChanges?(paths?: string[]): Promise<void> | void;
  restoreEditCheckpoint?(checkpointId: string): Promise<void> | void;
  gitRefreshing: boolean;
  refreshGitState(includeDiff?: boolean): Promise<void>;
  gitState: GitWorkspaceState;
  durationMs: number;
  messages: ChatMessage[];
  usage: UsageInfo;
  usageResolved: boolean;
  usedContextCount: number;
  selectedContextWindow?: number;
  contextTokens: number;
  contextTokenSource: "reported" | "estimated" | "partial";
  nextRequestTokens: number;
  contextWindowEstimated: boolean;
  calibrationFactor: number;
  compactActiveConversation(): void | Promise<void>;
  summaryOpen: boolean;
  setSummaryOpen(value: boolean): void;
  restoreSummarySnapshot(
    snapshot: NonNullable<TaskRecord["summarySnapshots"]>[number],
  ): void;
  rebuildActiveSummary(): Promise<void>;
  restoreFullContext(): void;
  /** Local (+ optional cloud) sessions for the multi-agent overview board. */
  overviewTasks?: AgentOverviewTaskInput[];
  onFocusOverviewSession?(taskId: string): void;
}

function resultStatus(activity: AgentActivity) {
  const view = normalizeActivity(activity);
  if (view.status === "waiting") return "待确认";
  if (view.status === "denied") return "已拒绝";
  return view.successful ? "通过" : view.statusLabel;
}

function fileName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
}

function FileChangeRow({
  change,
  active,
  busy,
  onClick,
  onKeep,
  onUndo,
}: {
  change: StatusFileChange;
  active: boolean;
  busy: boolean;
  onClick(): void;
  onKeep?(): void;
  onUndo?(): void;
}) {
  const kept = Boolean(change.kept);
  const pending = Boolean(change.pending) && !kept;
  return (
    <div
      className={`status-file-row-wrap ${active ? "is-active" : ""} ${kept ? "is-kept" : ""} ${pending ? "is-pending" : ""}`}
    >
      <button
        type="button"
        className={`status-file-row ${active ? "is-active" : ""}`}
        title={`弹窗查看 ${change.path} 的改动`}
        onClick={onClick}
      >
        <FileCode2 size={12} />
        <span className="status-file-row-name">
          <strong>{fileName(change.path)}</strong>
          {change.path.replace(/\\/g, "/") !== fileName(change.path) ? (
            <em title={change.path}>
              {change.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/") ||
                "."}
            </em>
          ) : (
            <em>工作区</em>
          )}
        </span>
        <small>
          {kept ? (
            "已保留"
          ) : change.additions || change.deletions ? (
            <>
              <b>+{change.additions}</b>
              <i>-{change.deletions}</i>
            </>
          ) : (
            "已变更"
          )}
        </small>
        <ChevronRight size={12} />
      </button>
      {pending && (onKeep || onUndo) ? (
        <div className="status-file-review-actions">
          {onKeep ? (
            <button
              type="button"
              className="status-file-keep"
              disabled={busy}
              title={`保留 ${change.path}`}
              aria-label={`保留 ${change.path}`}
              onClick={(event) => {
                event.stopPropagation();
                onKeep();
              }}
            >
              <Check size={12} />
              保留
            </button>
          ) : null}
          {onUndo ? (
            <button
              type="button"
              className="status-file-undo"
              disabled={busy}
              title={`撤销 ${change.path}`}
              aria-label={`撤销 ${change.path}`}
              onClick={(event) => {
                event.stopPropagation();
                onUndo();
              }}
            >
              <Undo2 size={12} />
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


function AgentOverviewRowButton({
  row,
  onFocus,
}: {
  row: AgentOverviewRow;
  onFocus?: (taskId: string) => void;
}) {
  const clickable = Boolean(row.focusable && row.taskId && onFocus);
  const phaseClass = `is-phase-${row.phase}`;
  const content = (
    <>
      <span className={`agent-overview-phase ${phaseClass}`} aria-hidden="true">
        {row.phase === "running" ? (
          <RefreshCw className="spinning" size={12} />
        ) : row.phase === "waiting" ? (
          <Clock3 size={12} />
        ) : row.phase === "failed" ? (
          <CircleAlert size={12} />
        ) : row.phase === "done" ? (
          <CheckCircle2 size={12} />
        ) : (
          <Bot size={12} />
        )}
      </span>
      <span className="agent-overview-main">
        <strong title={row.name}>{row.name}</strong>
        <em>
          <span className="agent-overview-role">{row.roleLabel}</span>
          <span className="agent-overview-sep">·</span>
          <span className="agent-overview-location">{row.locationLabel}</span>
          {row.detail ? (
            <>
              <span className="agent-overview-sep">·</span>
              <span className="agent-overview-detail" title={row.detail}>
                {row.detail}
              </span>
            </>
          ) : null}
        </em>
      </span>
      <small className={`agent-overview-status ${phaseClass}`}>
        {row.phaseLabel}
      </small>
      {clickable ? <ChevronRight size={12} /> : null}
    </>
  );

  if (!clickable) {
    return (
      <div
        className={`agent-overview-row ${row.active ? "is-active" : ""} ${phaseClass}`}
        role="listitem"
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`agent-overview-row is-button ${row.active ? "is-active" : ""} ${phaseClass}`}
      role="listitem"
      title={`切换到会话：${row.name}`}
      aria-label={`切换到会话 ${row.name}（${row.phaseLabel}）`}
      onClick={() => onFocus?.(row.taskId)}
    >
      {content}
    </button>
  );
}

export function StatusPanel({
  runStatus,
  activities,
  selectedTarget,
  checkpoints,
  activeTask,
  runningId,
  summaryBusy,
  resumeCheckpoint,
  editCheckpoints = [],
  keepFileChanges,
  undoFileChanges,
  restoreEditCheckpoint,
  gitRefreshing,
  refreshGitState,
  gitState,
  durationMs,
  messages,
  usage,
  usageResolved,
  usedContextCount,
  selectedContextWindow,
  contextTokens,
  contextTokenSource,
  nextRequestTokens,
  contextWindowEstimated,
  calibrationFactor,
  compactActiveConversation,
  summaryOpen,
  setSummaryOpen,
  restoreSummarySnapshot,
  rebuildActiveSummary,
  restoreFullContext,
  overviewTasks,
  onFocusOverviewSession,
}: StatusPanelProps) {
  const [liveDurationMs, setLiveDurationMs] = useState(durationMs);
  const [diffOpen, setDiffOpen] = useState(false);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string>();
  const [loadedFileDiff, setLoadedFileDiff] = useState("");
  const [fileDiffError, setFileDiffError] = useState("");
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [wrapDiffLines, setWrapDiffLines] = useState(true);
  const [diffViewMode, setDiffViewMode] = useState<"split" | "unified">("split");
  const [reviewBusy, setReviewBusy] = useState(false);
  const diffFileNavRef = useRef<HTMLElement | null>(null);
  const diffContentRef = useRef<HTMLDivElement | null>(null);
  const gitWorkspacePath = activeTask
    ? localWorkspacePath(activeTask)
    : undefined;
  useEffect(() => {
    if (!runningId || !activeTask?.startedAt) {
      setLiveDurationMs(durationMs);
      return;
    }
    const update = () => setLiveDurationMs(Date.now() - activeTask.startedAt!);
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [activeTask?.startedAt, durationMs, runningId]);

  const activitySummary = useMemo(
    () => summarizeStatusActivities(activities),
    [activities],
  );
  const agentOverview = useMemo(
    () =>
      buildAgentOverviewBoard({
        tasks: overviewTasks ?? (activeTask ? [activeTask] : []),
        activeTaskId: activeTask?.id,
        limit: 12,
        cloudAvailable: false,
      }),
    [activeTask, overviewTasks],
  );
  const fileChanges = activitySummary.fileChanges;
  const queuedCount = messages.filter((message) =>
    Boolean((message as ChatMessage & { queued?: boolean }).queued),
  ).length;
  const contextPercent = selectedContextWindow
    ? Math.min(100, Math.round((contextTokens / selectedContextWindow) * 100))
    : 0;
  const nextRequestPercent = selectedContextWindow
    ? Math.min(
        100,
        Math.round((nextRequestTokens / selectedContextWindow) * 100),
      )
    : 0;
  const autoCompactPercent = Math.round(CONTEXT_AUTO_COMPACT_RATIO * 100);
  const totalTokens = usage.input + usage.output;
  const currentPhase = workingPhase(activities, liveDurationMs);
  const running = runStatus === "running";
  const overviewTone = statusOverviewTone(runStatus);
  const headline = running
    ? currentPhase.phase
    : statusHeadline(runStatus, Boolean(activities.length));
  const showRunOverview = Boolean(
    runningId ||
    activities.length ||
    queuedCount ||
    (runStatus !== "idle" && liveDurationMs > 0),
  );
  const resultSource = activitySummary.validations.length
    ? activitySummary.validations
    : activitySummary.results;
  const resultActivities = resultSource.slice(-3).reverse();
  const resultTitle = activitySummary.validations.length
    ? "验证结果"
    : "命令结果";
  const taskCheckpoints = checkpoints.filter(
    (checkpoint) => checkpoint.taskId === activeTask?.id,
  );
  const displayChangeCount = fileChanges.length;
  const displayAdditions = activitySummary.additions;
  const displayDeletions = activitySummary.deletions;
  const showChanges = fileChanges.length > 0;
  const pendingFileChanges = fileChanges.filter(
    (change) => change.pending && !change.kept,
  );
  const keptFileCount = fileChanges.filter((change) => change.kept).length;
  const taskEditCheckpoints = editCheckpoints.filter(
    (checkpoint) =>
      !activeTask?.id ||
      !checkpoint.taskId ||
      checkpoint.taskId === activeTask.id,
  );
  async function runReviewAction(
    action?: (paths?: string[]) => Promise<void> | void,
    paths?: string[],
  ) {
    if (!action || reviewBusy) return;
    setReviewBusy(true);
    try {
      await action(paths);
    } finally {
      setReviewBusy(false);
    }
  }
  async function runRestoreCheckpoint(checkpointId: string) {
    if (!restoreEditCheckpoint || reviewBusy) return;
    setReviewBusy(true);
    try {
      await restoreEditCheckpoint(checkpointId);
    } finally {
      setReviewBusy(false);
    }
  }
  const selectedDiffChange = fileChanges.find(
    (change) => change.path === selectedDiffPath,
  );
  const selectedDiffText = selectedDiffChange?.diffs.length
    ? selectedDiffChange.diffs.join("\n\n")
    : selectedDiffPath
      ? loadedFileDiff || extractGitFileDiff(gitState.diff, selectedDiffPath)
      : gitState.diff;
  const openDiff = (path?: string) => {
    const nextPath = path || fileChanges[0]?.path;
    if (nextPath !== selectedDiffPath) {
      setLoadedFileDiff("");
      setFileDiffError("");
    }
    setSelectedDiffPath(nextPath);
    setDiffOpen(true);
    const hasActivityDiff = Boolean(
      nextPath &&
        fileChanges.find((change) => change.path === nextPath)?.diffs.length,
    );
    if (!hasActivityDiff && !gitState.diff) void refreshGitState(true);
  };
  useEffect(() => {
    setDiffOpen(false);
    setSelectedDiffPath(undefined);
    setLoadedFileDiff("");
    setFileDiffError("");
  }, [activeTask?.id, runningId]);
  useEffect(() => {
    if (
      !diffOpen ||
      !selectedDiffPath ||
      selectedDiffChange?.diffs.length ||
      extractGitFileDiff(gitState.diff, selectedDiffPath) ||
      !gitWorkspacePath ||
      !window.kcode?.workspace.gitFileDiff
    )
      return;
    let cancelled = false;
    setFileDiffLoading(true);
    void window.kcode.workspace
      .gitFileDiff(gitWorkspacePath, selectedDiffPath)
      .then((result) => {
        if (cancelled) return;
        setLoadedFileDiff(result.diff);
        setFileDiffError(result.error || "");
      })
      .catch((error) => {
        if (!cancelled)
          setFileDiffError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (!cancelled) setFileDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    gitWorkspacePath,
    diffOpen,
    gitState.diff,
    selectedDiffChange?.diffs.length,
    selectedDiffPath,
  ]);
  useEffect(() => {
    if (!diffOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDiffOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffOpen]);

  useEffect(() => {
    if (!diffOpen) return;
    const content = diffContentRef.current;
    if (content) content.scrollTop = 0;
    const nav = diffFileNavRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>("button.is-active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [diffOpen, selectedDiffPath, selectedDiffText]);

  const showUsage =
    runStatus !== "idle" || liveDurationMs > 0 || messages.length > 0;
  const runEmpty =
    !showRunOverview &&
    resultActivities.length === 0 &&
    taskCheckpoints.length === 0;

  return (
    <aside className="status-panel work-panel is-unified" aria-label="工作面板">
      <div className="work-panel-body">
        <section className="work-panel-block" aria-label="智能体总览">
          <section className="agent-overview-board" aria-label="智能体总览面板">
            <div className="status-section-heading agent-overview-heading">
              <span>
                <Users size={14} />
                <strong>智能体总览</strong>
              </span>
              <small>
                {agentOverview.runningCount
                  ? `${agentOverview.runningCount} 运行`
                  : "无运行"}
                {agentOverview.waitingCount
                  ? ` · ${agentOverview.waitingCount} 等待`
                  : ""}
                {agentOverview.localCount
                  ? ` · ${agentOverview.localCount} 本地`
                  : ""}
              </small>
            </div>
            {agentOverview.rows.length === 0 ? (
              <p className="work-panel-empty is-inline agent-overview-empty">
                暂无运行中或等待中的会话。完整列表在左侧侧栏。
              </p>
            ) : (
              <div className="agent-overview-list" role="list">
                {agentOverview.rows.map((row) => (
                  <AgentOverviewRowButton
                    key={row.id}
                    row={row}
                    onFocus={onFocusOverviewSession}
                  />
                ))}
              </div>
            )}
            {agentOverview.cloudUnavailable ? (
              <p className="agent-overview-cloud-hint" data-extension="cloud-agents">
                <CloudOff size={12} />
                <span>云端智能体尚未接入 · 当前仅展示本地 / SSH 会话</span>
              </p>
            ) : null}
          </section>
        </section>

                <section className="work-panel-block" aria-label="改动">
          {showChanges ? (
            <section className="git-section status-changes-section is-compact">
              <div className="status-change-total">
                <span>
                  <strong>{displayChangeCount} 个文件</strong>
                  <small>
                    本轮改动
                    {pendingFileChanges.length
                      ? ` · ${pendingFileChanges.length} 待确认`
                      : keptFileCount
                        ? ` · ${keptFileCount} 已保留`
                        : ""}
                  </small>
                </span>
                <b>
                  <i>+{displayAdditions}</i>
                  <em>-{displayDeletions}</em>
                </b>
                <div className="work-panel-heading-actions">
                  <button
                    className={gitRefreshing ? "spinning" : ""}
                    onClick={() => void refreshGitState()}
                    title="刷新 Git 状态"
                    aria-label="刷新 Git 状态"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
              </div>
              {pendingFileChanges.length > 0 &&
              (keepFileChanges || undoFileChanges) ? (
                <div className="status-review-toolbar" aria-label="改动审查">
                  {keepFileChanges ? (
                    <button
                      type="button"
                      className="status-review-keep-all"
                      disabled={reviewBusy}
                      onClick={() =>
                        void runReviewAction(keepFileChanges, undefined)
                      }
                    >
                      <Check size={12} />
                      全部保留
                    </button>
                  ) : null}
                  {undoFileChanges ? (
                    <button
                      type="button"
                      className="status-review-undo-all"
                      disabled={reviewBusy}
                      onClick={() =>
                        void runReviewAction(undoFileChanges, undefined)
                      }
                    >
                      <Undo2 size={12} />
                      全部撤销
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="status-file-list">
                <div className="status-file-list-scroll">
                  {fileChanges.map((change) => (
                    <FileChangeRow
                      key={change.path}
                      change={change}
                      active={diffOpen && change.path === selectedDiffPath}
                      busy={reviewBusy}
                      onClick={() => openDiff(change.path)}
                      onKeep={
                        keepFileChanges && change.pending && !change.kept
                          ? () =>
                              void runReviewAction(keepFileChanges, [
                                change.path,
                              ])
                          : undefined
                      }
                      onUndo={
                        undoFileChanges && change.pending && !change.kept
                          ? () =>
                              void runReviewAction(undoFileChanges, [
                                change.path,
                              ])
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
              {taskEditCheckpoints.length > 0 ? (
                <div
                  className="status-edit-checkpoints"
                  aria-label="文件还原点"
                >
                  <div className="status-section-heading">
                    <span>
                      <RotateCcw size={14} />
                      <strong>文件还原点</strong>
                    </span>
                    <small>不删除对话</small>
                  </div>
                  {taskEditCheckpoints.map((checkpoint) => (
                    <button
                      type="button"
                      className="status-edit-checkpoint"
                      key={checkpoint.id}
                      disabled={
                        reviewBusy || Boolean(runningId) || summaryBusy
                      }
                      title={`还原 ${checkpoint.fileCount} 个文件到「${checkpoint.label}」`}
                      onClick={() => void runRestoreCheckpoint(checkpoint.id)}
                    >
                      <RotateCcw size={13} />
                      <span>
                        <strong>{checkpoint.label}</strong>
                        <small>
                          {checkpoint.fileCount} 个文件 ·{" "}
                          {new Date(checkpoint.createdAt).toLocaleString()}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : (
            <p className="work-panel-empty is-inline">本轮还没有文件改动。</p>
          )}
        </section>

<section className="work-panel-block" aria-label="本轮">
          {showRunOverview && (
            <section
              className={`status-run-overview is-compact ${running ? "is-running" : ""} ${runStatus === "blocked" ? "is-blocked" : ""} ${overviewTone === "success" ? "is-success" : ""} ${overviewTone === "failure" ? "has-failures" : ""}`}
            >
              <div className="status-section-heading">
                <span>
                  {running ? (
                    <Activity size={14} />
                  ) : overviewTone === "failure" ? (
                    <CircleAlert size={14} />
                  ) : runStatus === "blocked" ? (
                    <Clock3 size={14} />
                  ) : (
                    <CheckCircle2 size={14} />
                  )}
                  <strong>{headline}</strong>
                </span>
                <time>{formatDuration(liveDurationMs)}</time>
              </div>
              {running && activitySummary.active && (
                <code title={activityTarget(activitySummary.active)}>
                  {activityTarget(activitySummary.active) ||
                    activitySummary.active.title}
                </code>
              )}
              {running && !activitySummary.active && (
                <p className="status-live-detail">{currentPhase.detail}</p>
              )}
              <div className="status-run-stats">
                {activitySummary.total > 0 ? (
                  <span>
                    <b>{activitySummary.completed}</b>/{activitySummary.total} 步
                  </span>
                ) : (
                  <span>正在准备步骤</span>
                )}
                {activitySummary.commands > 0 && (
                  <span>{activitySummary.commands} 个命令</span>
                )}
                {fileChanges.length > 0 && <span>{fileChanges.length} 个文件</span>}
                {queuedCount > 0 && <span>{queuedCount} 条排队</span>}
                {activitySummary.failures > 0 && (
                  <span className="status-failure-count">
                    {activitySummary.failures} 项失败
                  </span>
                )}
              </div>
            </section>
          )}

          {resultActivities.length > 0 && (
            <section className="status-results-section">
              <div className="status-section-heading">
                <span>
                  <Terminal size={14} />
                  <strong>{resultTitle}</strong>
                </span>
                <small>{resultSource.length} 次执行</small>
              </div>
              <div className="status-result-list">
                {resultActivities.map((activity) => {
                  const failed =
                    activity.status === "failed" || activity.status === "denied";
                  const active =
                    activity.status === "running" || activity.status === "waiting";
                  return (
                    <div
                      className={`status-result-row ${failed ? "failed" : ""} ${active ? "active" : ""}`}
                      key={activity.id}
                    >
                      {failed ? (
                        <CircleAlert size={13} />
                      ) : active ? (
                        <RefreshCw className="spinning" size={13} />
                      ) : (
                        <CheckCircle2 size={13} />
                      )}
                      <span>
                        <strong>{activity.title}</strong>
                        <code title={activity.command || activityTarget(activity)}>
                          {activity.command || activityTarget(activity) || "已完成"}
                        </code>
                      </span>
                      <small>{resultStatus(activity)}</small>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {taskCheckpoints.length > 0 && (
            <section className="status-recovery-section">
              <div className="status-section-heading">
                <span>
                  <RotateCcw size={14} />
                  <strong>可恢复任务</strong>
                </span>
              </div>
              {taskCheckpoints.map((checkpoint) => (
                <button
                  className="resume-checkpoint"
                  key={checkpoint.id}
                  disabled={Boolean(runningId) || summaryBusy}
                  onClick={() => void resumeCheckpoint(checkpoint)}
                >
                  <RefreshCw size={13} />
                  <span>
                    <strong>从检查点继续</strong>
                    <small>{new Date(checkpoint.startedAt).toLocaleString()}</small>
                  </span>
                </button>
              ))}
            </section>
          )}
          {runEmpty && !showChanges && (
            <p className="work-panel-empty is-inline">本轮还没有执行记录。</p>
          )}
        </section>

        <section className="work-panel-block" aria-label="上下文">
          {showUsage && (
            <section className="status-usage-section is-compact">
              {selectedContextWindow ? (
                <div className="context-usage context-usage-hero">
                  <div>
                    <span>
                      上下文预算
                      <em className="context-source-label">
                        {contextTokenSource === "reported"
                          ? "渠道实测"
                          : contextTokenSource === "partial"
                            ? "近期记录估算"
                            : "本地估算"}
                      </em>
                    </span>
                    <strong>{contextPercent}%</strong>
                  </div>
                  <div className="context-usage-bar">
                    <i style={{ width: `${contextPercent}%` }} />
                    <b
                      style={{ left: `${autoCompactPercent}%` }}
                      title={`${autoCompactPercent}% 自动压缩线`}
                    />
                  </div>
                  <div className="context-budget-meta">
                    <small>
                      {contextTokens.toLocaleString()} /{" "}
                      {selectedContextWindow.toLocaleString()} Token
                      {contextWindowEstimated ? "（窗口推测值）" : ""}
                    </small>
                    <small>{autoCompactPercent}% 自动压缩</small>
                  </div>
                  <div className="context-next-budget">
                    <span>
                      下次请求
                      <small>含附件与输出预留</small>
                    </span>
                    <strong>{nextRequestPercent}%</strong>
                    <small>{nextRequestTokens.toLocaleString()} Token</small>
                  </div>
                </div>
              ) : (
                <div className="context-usage context-usage-hero">
                  <div>
                    <span>上下文预算</span>
                    <strong>未配置</strong>
                  </div>
                  <small>请在模型设置中填写上下文窗口</small>
                </div>
              )}
              <div className="run-metrics">
                <div>
                  <Clock3 size={14} />
                  <span>
                    <small>耗时</small>
                    <strong>{formatDuration(liveDurationMs)}</strong>
                  </span>
                </div>
                <div>
                  <BrainCircuit size={14} />
                  <span>
                    <small>Token</small>
                    <strong>
                      {totalTokens
                        ? totalTokens.toLocaleString()
                        : usageResolved
                          ? "渠道未返回"
                          : "计算中"}
                    </strong>
                  </span>
                </div>
                {usedContextCount > 0 && (
                  <div>
                    <Paperclip size={14} />
                    <span>
                      <small>引用</small>
                      <strong>{usedContextCount} 文件</strong>
                    </span>
                  </div>
                )}
              </div>
              {totalTokens > 0 && (
                <div className="token-split">
                  <span>输入 {usage.input.toLocaleString()}</span>
                  <i />
                  <span>输出 {usage.output.toLocaleString()}</span>
                  <i />
                  <span>缓存 {usage.cached.toLocaleString()}</span>
                </div>
              )}
              {Math.abs(calibrationFactor - 1) >= 0.01 && (
                <small className="calibration-status">
                  估算已按当前渠道校准 ×{calibrationFactor.toFixed(2)}
                </small>
              )}
              <button
                className="compact-context-button"
                type="button"
                disabled={Boolean(runningId) || summaryBusy}
                onClick={() => void compactActiveConversation()}
                title="按 Token 预算压缩较早消息并保留关键状态"
              >
                <Minimize2 size={13} />
                压缩上下文
              </button>
              {(activeTask?.compactedMessageCount ?? 0) > 0 && (
                <small className="compaction-status">
                  已压缩 {activeTask?.compactedMessageCount} 条较早消息
                </small>
              )}
              {activeTask?.contextSummary && (
                <button
                  className="view-summary-button"
                  type="button"
                  onClick={() => setSummaryOpen(true)}
                >
                  查看压缩摘要
                </button>
              )}
            </section>
          )}
          {!showUsage && !selectedTarget && (
            <p className="work-panel-empty is-inline">还没有上下文用量。</p>
          )}
        </section>
      </div>

      {diffOpen &&
        createPortal(
        <div
          className="git-diff-layer"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setDiffOpen(false)
          }
        >
          <section
            className="git-diff-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="查看文件更新"
          >
            <header>
              <span>
                <GitCompareArrows size={16} />
                <strong>文件更新</strong>
              </span>
              <div className="git-diff-dialog-actions">
                <button
                  type="button"
                  className={diffViewMode === "split" ? "is-active" : ""}
                  title="左右分栏对比"
                  aria-label="左右分栏对比"
                  aria-pressed={diffViewMode === "split"}
                  onClick={() => setDiffViewMode("split")}
                >
                  <Columns2 size={15} />
                </button>
                <button
                  type="button"
                  className={diffViewMode === "unified" ? "is-active" : ""}
                  title="统一视图"
                  aria-label="统一视图"
                  aria-pressed={diffViewMode === "unified"}
                  onClick={() => setDiffViewMode("unified")}
                >
                  <SquareSplitVertical size={15} />
                </button>
                <button
                  type="button"
                  className={wrapDiffLines ? "is-active" : ""}
                  title={
                    wrapDiffLines ? "关闭长行自动换行" : "开启长行自动换行"
                  }
                  aria-label={
                    wrapDiffLines ? "关闭长行自动换行" : "开启长行自动换行"
                  }
                  aria-pressed={wrapDiffLines}
                  onClick={() => setWrapDiffLines((value) => !value)}
                >
                  <TextWrap size={15} />
                </button>
                <button
                  type="button"
                  title="关闭"
                  aria-label="关闭文件更新"
                  onClick={() => setDiffOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
            </header>
            <div className="git-diff-dialog-body">
              {fileChanges.length > 0 && (
                <nav ref={diffFileNavRef} className="git-diff-file-nav" aria-label="更新文件">
                  <button
                    type="button"
                    className={`git-diff-file-nav-all${!selectedDiffPath ? " is-active" : ""}`}
                    onClick={() => {
                      setSelectedDiffPath(undefined);
                      setLoadedFileDiff("");
                      setFileDiffError("");
                      if (!gitState.diff) void refreshGitState(true);
                    }}
                  >
                    <span>全部更新</span>
                    <small>
                      +{displayAdditions} -{displayDeletions}
                    </small>
                  </button>
                  {fileChanges.map((change) => (
                    <button
                      type="button"
                      key={change.path}
                      className={
                        change.path === selectedDiffPath ? "is-active" : ""
                      }
                      onClick={() => openDiff(change.path)}
                      title={change.path}
                    >
                      <span className="git-diff-file-nav-name">
                        <strong>{fileName(change.path)}</strong>
                        <em title={change.path}>{change.path}</em>
                      </span>
                      <small>
                        +{change.additions} -{change.deletions}
                      </small>
                    </button>
                  ))}
                </nav>
              )}
              <div ref={diffContentRef} className="git-diff-dialog-content">
                {fileDiffLoading || (gitRefreshing && !selectedDiffText) ? (
                  <div className="git-diff-loading">
                    <RefreshCw className="spinning" size={14} />
                    正在读取更新
                  </div>
                ) : fileDiffError ? (
                  <pre className="git-diff-empty">{fileDiffError}</pre>
                ) : selectedDiffText ? (
                  <DiffView
                    key={`${selectedDiffPath || "all"}:${diffViewMode}:${wrapDiffLines}`}
                    text={selectedDiffText}
                    wrapLines={wrapDiffLines}
                    mode={diffViewMode}
                    virtualize
                  />
                ) : (
                  <pre className="git-diff-empty">
                    {selectedDiffPath
                      ? "该文件当前没有可显示的文本差异。"
                      : gitState.summary || "当前没有可显示的更新。"}
                  </pre>
                )}
              </div>
            </div>
          </section>
        </div>
      ,
          document.body,
        )}

      {summaryOpen && activeTask?.contextSummary && (
        <div
          className="summary-layer"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setSummaryOpen(false)
          }
        >
          <div className="summary-dialog">
            <header>
              <strong>上下文摘要</strong>
              <button title="关闭" onClick={() => setSummaryOpen(false)}>
                <X size={16} />
              </button>
            </header>
            <div className="summary-meta">
              <span>
                {activeTask.summaryMeta?.modelGenerated
                  ? "模型摘要"
                  : "本地摘要"}
              </span>
              {activeTask.summaryMeta?.modelId ? (
                <span>{activeTask.summaryMeta.modelId}</span>
              ) : null}
              {activeTask.summaryMeta?.durationMs ? (
                <span>{formatDuration(activeTask.summaryMeta.durationMs)}</span>
              ) : null}
              {activeTask.summaryMeta?.usage ? (
                <span>
                  {activeTask.summaryMeta.usage.input +
                    activeTask.summaryMeta.usage.output}{" "}
                  Token
                </span>
              ) : null}
            </div>
            <pre>{activeTask.contextSummary}</pre>
            {Boolean(activeTask.summarySnapshots?.length) && (
              <div className="summary-versions">
                <strong>历史版本</strong>
                {activeTask.summarySnapshots!.map((snapshot) => (
                  <button
                    key={snapshot.id}
                    disabled={summaryBusy || Boolean(runningId)}
                    onClick={() => restoreSummarySnapshot(snapshot)}
                  >
                    <span>
                      {new Date(snapshot.createdAt).toLocaleString()} ·{" "}
                      {snapshot.modelGenerated ? "模型" : "本地"}
                    </span>
                    <RotateCcw size={12} />
                  </button>
                ))}
              </div>
            )}
            <footer>
              <button
                disabled={Boolean(runningId) || summaryBusy}
                onClick={() => void rebuildActiveSummary()}
              >
                <RefreshCw
                  className={summaryBusy ? "spinning" : ""}
                  size={13}
                />
                {summaryBusy ? "生成中" : "重新生成"}
              </button>
              <button
                className="restore-context-button"
                disabled={Boolean(runningId) || summaryBusy}
                onClick={restoreFullContext}
              >
                <RotateCcw size={13} />
                恢复完整上下文
              </button>
            </footer>
          </div>
        </div>
      )}
    </aside>
  );
}
