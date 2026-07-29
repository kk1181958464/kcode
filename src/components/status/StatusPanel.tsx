import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileCode2,
  GitCompareArrows,
  Minimize2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CONTEXT_AUTO_COMPACT_RATIO } from "../../context";
import { activityTarget, formatDuration, workingPhase } from "../../lib/format";
import type { TaskRecord } from "../../models";
import {
  summarizeStatusActivities,
  type StatusFileChange,
} from "../../status-summary";
import type { TaskRunStatus } from "../../task-status";
import type {
  AgentActivity,
  AgentCheckpoint,
  ChatMessage,
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
  effortLabels: Record<ReasoningEffort, string>;
  reasoningEffort: ReasoningEffort;
  checkpoints: AgentCheckpoint[];
  activeTask: TaskRecord | undefined;
  runningId: string | undefined;
  summaryBusy: boolean;
  resumeCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  gitRefreshing: boolean;
  refreshGitState(includeDiff?: boolean): Promise<void>;
  gitState: GitWorkspaceState;
  gitDiffOpen: boolean;
  setGitDiffOpen(updater: (value: boolean) => boolean): void;
  durationMs: number;
  messages: ChatMessage[];
  usage: UsageInfo;
  usageResolved: boolean;
  usedContextCount: number;
  selectedContextWindow?: number;
  contextTokens: number;
  calibrationFactor: number;
  compactActiveConversation(): void | Promise<void>;
  summaryOpen: boolean;
  setSummaryOpen(value: boolean): void;
  restoreSummarySnapshot(
    snapshot: NonNullable<TaskRecord["summarySnapshots"]>[number],
  ): void;
  rebuildActiveSummary(): Promise<void>;
  restoreFullContext(): void;
}

function resultStatus(activity: AgentActivity) {
  if (activity.status === "running") return "执行中";
  if (activity.status === "waiting") return "待确认";
  if (activity.status === "failed") return "失败";
  if (activity.status === "denied") return "已拒绝";
  return "通过";
}

function statusHeadline(runStatus: TaskRunStatus, hasActivities: boolean) {
  if (runStatus === "failed") return "本轮执行失败";
  if (runStatus === "cancelled") return "本轮已停止";
  if (runStatus === "paused") return "任务可以恢复";
  if (runStatus === "completed") return "本轮执行完成";
  if (runStatus === "running") return "正在生成回复";
  return hasActivities ? "最近一轮" : "";
}

function fileName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
}

function FileChangeRow({ change }: { change: StatusFileChange }) {
  return (
    <div className="status-file-row" title={change.path}>
      <FileCode2 size={12} />
      <span>{fileName(change.path)}</span>
      <small>
        <b>+{change.additions}</b>
        <i>-{change.deletions}</i>
      </small>
    </div>
  );
}

export function StatusPanel({
  runStatus,
  activities,
  selectedTarget,
  effortLabels,
  reasoningEffort,
  checkpoints,
  activeTask,
  runningId,
  summaryBusy,
  resumeCheckpoint,
  gitRefreshing,
  refreshGitState,
  gitState,
  gitDiffOpen,
  setGitDiffOpen,
  durationMs,
  messages,
  usage,
  usageResolved,
  usedContextCount,
  selectedContextWindow,
  contextTokens,
  calibrationFactor,
  compactActiveConversation,
  summaryOpen,
  setSummaryOpen,
  restoreSummarySnapshot,
  rebuildActiveSummary,
  restoreFullContext,
}: StatusPanelProps) {
  const [liveDurationMs, setLiveDurationMs] = useState(durationMs);
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
  const queuedCount = messages.filter((message) =>
    Boolean((message as ChatMessage & { queued?: boolean }).queued),
  ).length;
  const contextPercent = selectedContextWindow
    ? Math.min(100, Math.round((contextTokens / selectedContextWindow) * 100))
    : 0;
  const autoCompactPercent = Math.round(CONTEXT_AUTO_COMPACT_RATIO * 100);
  const totalTokens = usage.input + usage.output;
  const currentPhase = workingPhase(activities, liveDurationMs);
  const running = runStatus === "running";
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
  const useGitChangeTotals = gitState.available && gitState.files > 0;
  const displayChangeCount = useGitChangeTotals
    ? gitState.files
    : activitySummary.fileChanges.length;
  const displayAdditions = useGitChangeTotals
    ? gitState.additions
    : activitySummary.additions;
  const displayDeletions = useGitChangeTotals
    ? gitState.deletions
    : activitySummary.deletions;
  const showChanges =
    activitySummary.fileChanges.length > 0 ||
    (gitState.available && gitState.files > 0);

  return (
    <aside className="status-panel" aria-label="任务详情">
      {showRunOverview && (
        <section
          className={`status-run-overview ${running ? "is-running" : ""} ${activitySummary.failures ? "has-failures" : ""}`}
        >
          <div className="status-section-heading">
            <span>
              {running ? (
                <Activity size={14} />
              ) : activitySummary.failures || runStatus === "failed" ? (
                <CircleAlert size={14} />
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
            {activitySummary.fileChanges.length > 0 && (
              <span>{activitySummary.fileChanges.length} 个文件</span>
            )}
            {queuedCount > 0 && <span>{queuedCount} 条排队</span>}
            {activitySummary.failures > 0 && (
              <span className="status-failure-count">
                {activitySummary.failures} 项失败
              </span>
            )}
          </div>
        </section>
      )}

      {showChanges && (
        <section className="git-section status-changes-section">
          <div className="status-section-heading">
            <span>
              <GitCompareArrows size={14} />
              <strong>改动概览</strong>
            </span>
            <button
              className={gitRefreshing ? "spinning" : ""}
              onClick={() => void refreshGitState()}
              title="刷新 Git 状态"
              aria-label="刷新 Git 状态"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="status-change-total">
            <span>
              <strong>{displayChangeCount} 个文件</strong>
              <small>
                {useGitChangeTotals
                  ? `${gitState.branch || "Git 工作区"} · 工作区总计`
                  : "本轮工具记录"}
              </small>
            </span>
            <b>
              <i>+{displayAdditions}</i>
              <em>-{displayDeletions}</em>
            </b>
          </div>
          {activitySummary.fileChanges.length > 0 && (
            <div className="status-file-list">
              <small>本轮涉及</small>
              {activitySummary.fileChanges.slice(0, 4).map((change) => (
                <FileChangeRow key={change.path} change={change} />
              ))}
              {activitySummary.fileChanges.length > 4 && (
                <p>另有 {activitySummary.fileChanges.length - 4} 个文件</p>
              )}
            </div>
          )}
          {gitState.available && gitState.files > 0 && (
            <button
              className="git-diff-toggle"
              onClick={() =>
                setGitDiffOpen((value) => {
                  const next = !value;
                  if (next) void refreshGitState(true);
                  return next;
                })
              }
            >
              {gitDiffOpen ? "收起工作区差异" : "查看工作区差异"}
              <ChevronDown size={13} />
            </button>
          )}
          {gitDiffOpen &&
            (gitState.diff ? (
              <DiffView text={gitState.diff} className="git-diff-view" />
            ) : (
              <pre className="git-diff-view">{gitState.summary}</pre>
            ))}
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

      {(runStatus !== "idle" || liveDurationMs > 0 || messages.length > 0) && (
        <section className="status-usage-section">
          <div className="status-section-heading">
            <span>
              <BrainCircuit size={14} />
              <strong>上下文与用量</strong>
            </span>
          </div>
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
                  <small>引用上下文</small>
                  <strong>{usedContextCount} 个文件</strong>
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
          {selectedContextWindow ? (
            <div className="context-usage">
              <div>
                <span>当前上下文占用</span>
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
                </small>
                <small>{autoCompactPercent}% 时自动压缩</small>
              </div>
            </div>
          ) : (
            <div className="context-usage">
              <div>
                <span>当前上下文占用</span>
                <strong>未配置</strong>
              </div>
              <small>请在模型设置中填写上下文窗口</small>
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

      {selectedTarget && (
        <footer
          className="status-model-line"
          title={`${selectedTarget.provider.name} / ${selectedTarget.model.modelId}`}
        >
          <BrainCircuit size={13} />
          <span>
            <strong>{selectedTarget.model.displayName}</strong>
            <small>{effortLabels[reasoningEffort]}</small>
          </span>
        </footer>
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
