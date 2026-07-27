import {
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileCode2,
  GitCompareArrows,
  LockOpen,
  Minimize2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { TaskRunStatus } from "../../task-status";
import type {
  AgentCheckpoint,
  GitWorkspaceState,
  ModelConfig,
  PermissionMode,
  ReasoningEffort,
} from "../../types";
import type { ProviderConfig } from "../../types";
import type { TaskRecord } from "../../models";
import { formatDuration } from "../../lib/format";
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
  taskComplete: boolean;
  runStatusTitle: Record<TaskRunStatus, string>;
  runStatusDescription: Record<TaskRunStatus, string>;
  connected: boolean;
  providers: ProviderConfig[];
  models: ModelEntry[];
  selectedTarget: ModelEntry | undefined;
  effortLabels: Record<ReasoningEffort, string>;
  reasoningEffort: ReasoningEffort;
  checkpoints: AgentCheckpoint[];
  activeTask: TaskRecord | undefined;
  runningId: string | undefined;
  summaryBusy: boolean;
  resumeCheckpoint(checkpoint: AgentCheckpoint): Promise<void>;
  gitRefreshing: boolean;
  refreshGitState(): Promise<void>;
  gitState: GitWorkspaceState;
  gitDiffOpen: boolean;
  setGitDiffOpen(updater: (value: boolean) => boolean): void;
  durationMs: number;
  messages: unknown[];
  usage: UsageInfo;
  usageResolved: boolean;
  usedContextCount: number;
  selectedContextWindow?: number;
  contextTokens: number;
  calibrationFactor: number;
  compactActiveConversation(): void;
  summaryOpen: boolean;
  setSummaryOpen(value: boolean): void;
  restoreSummarySnapshot(
    snapshot: NonNullable<TaskRecord["summarySnapshots"]>[number],
  ): void;
  rebuildActiveSummary(): Promise<void>;
  restoreFullContext(): void;
  permissionMode: PermissionMode;
}

export function StatusPanel({
  runStatus,
  taskComplete,
  runStatusTitle,
  runStatusDescription,
  connected,
  providers,
  models,
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
  permissionMode,
}: StatusPanelProps) {
  return (
    <aside className="status-panel">
      <header>
        <span>任务状态</span>
        {taskComplete ? (
          <CheckCircle2 size={17} />
        ) : runStatus === "failed" || runStatus === "paused" ? (
          <CircleAlert size={17} />
        ) : (
          <Check size={16} />
        )}
      </header>
      <section>
        <span className="eyebrow">当前目标</span>
        <h3>{runStatusTitle[runStatus]}</h3>
        <div className="progress">
          <i
            style={{
              width:
                runStatus === "running"
                  ? "78%"
                  : runStatus !== "idle"
                    ? "100%"
                    : connected
                      ? "66%"
                      : "33%",
            }}
          />
        </div>
        <p>{runStatusDescription[runStatus]}</p>
      </section>
      <section>
        <span className="eyebrow">运行环境</span>
        <dl>
          <div>
            <dt>供应商</dt>
            <dd>{providers.filter((p) => p.enabled).length}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{models.length}</dd>
          </div>
          <div>
            <dt>当前模型</dt>
            <dd className="truncate">
              {selectedTarget?.model.displayName ?? "未选择"}
            </dd>
          </div>
          <div>
            <dt>推理强度</dt>
            <dd>{effortLabels[reasoningEffort]}</dd>
          </div>
        </dl>
        {checkpoints
          .filter((checkpoint) => checkpoint.taskId === activeTask?.id)
          .map((checkpoint) => (
            <button
              className="resume-checkpoint"
              key={checkpoint.id}
              disabled={Boolean(runningId) || summaryBusy}
              onClick={() => void resumeCheckpoint(checkpoint)}
            >
              <RefreshCw size={13} />
              <span>
                <strong>继续未完成任务</strong>
                <small>{new Date(checkpoint.startedAt).toLocaleString()}</small>
              </span>
            </button>
          ))}
      </section>
      <section className="git-section">
        <div className="git-section-head">
          <span className="eyebrow">工作区变更</span>
          <button
            className={gitRefreshing ? "spinning" : ""}
            onClick={() => void refreshGitState()}
            title="刷新 Git 状态"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {gitState.available ? (
          <>
            <div className="git-summary">
              <GitCompareArrows size={15} />
              <span>
                <strong>
                  {gitState.files
                    ? `${gitState.files} 个文件`
                    : "没有未提交变更"}
                </strong>
                <small>{gitState.branch}</small>
              </span>
              {gitState.files > 0 && (
                <b>
                  <i>+{gitState.additions}</i>
                  <em>-{gitState.deletions}</em>
                </b>
              )}
            </div>
            {gitState.files > 0 && (
              <button
                className="git-diff-toggle"
                onClick={() => setGitDiffOpen((value) => !value)}
              >
                {gitDiffOpen ? "收起差异" : "查看差异"}
                <ChevronDown size={13} />
              </button>
            )}
            {gitDiffOpen &&
              (gitState.diff ? (
                <DiffView text={gitState.diff} className="git-diff-view" />
              ) : (
                <pre className="git-diff-view">{gitState.summary}</pre>
              ))}
          </>
        ) : (
          <p>{gitState.error || "当前工作区未初始化 Git"}</p>
        )}
      </section>
      {(runStatus !== "idle" || durationMs > 0 || messages.length > 0) && (
        <section>
          <span className="eyebrow">本轮用量</span>
          <div className="run-metrics">
            <div>
              <Clock3 size={14} />
              <span>
                <small>耗时</small>
                <strong>{formatDuration(durationMs)}</strong>
              </span>
            </div>
            <div>
              <BrainCircuit size={14} />
              <span>
                <small>Token</small>
                <strong>
                  {usage.input + usage.output
                    ? (usage.input + usage.output).toLocaleString()
                    : usageResolved
                      ? "渠道未返回"
                      : "计算中"}
                </strong>
              </span>
            </div>
            <div>
              <Paperclip size={14} />
              <span>
                <small>上下文</small>
                <strong>{usedContextCount} 个文件</strong>
              </span>
            </div>
          </div>
          {usage.input + usage.output > 0 && (
            <div className="token-split">
              <span>输入 {usage.input}</span>
              <i />
              <span>输出 {usage.output}</span>
              <i />
              <span>缓存 {usage.cached}</span>
            </div>
          )}
          <>
            {selectedContextWindow ? (
              <div className="context-usage">
                <div>
                  <span>上下文预算</span>
                  <strong>
                    {Math.min(
                      100,
                      Math.round((contextTokens / selectedContextWindow) * 100),
                    )}
                    %
                  </strong>
                </div>
                <div className="context-usage-bar">
                  <i
                    style={{
                      width: `${Math.min(100, (contextTokens / selectedContextWindow) * 100)}%`,
                    }}
                  />
                </div>
                <small>
                  {contextTokens.toLocaleString()} /{" "}
                  {selectedContextWindow.toLocaleString()} Token
                </small>
              </div>
            ) : (
              <div className="context-usage">
                <div>
                  <span>上下文占用</span>
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
              disabled={Boolean(runningId)}
              onClick={compactActiveConversation}
              title="按 Token 预算压缩较早消息并保留关键状态"
            >
              <Minimize2 size={13} />
              压缩上下文
            </button>
            {(activeTask?.compactedMessageCount ?? 0) > 0 && (
              <small className="compaction-status">
                已压缩 {activeTask?.compactedMessageCount} 条消息
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
          </>
        </section>
      )}
      <section className="permission-section">
        <span className="eyebrow">操作权限</span>
        <div className="permission-row">
          {permissionMode === "full-access" ? (
            <LockOpen size={16} />
          ) : permissionMode === "read-only" ? (
            <FileCode2 size={16} />
          ) : (
            <ShieldCheck size={16} />
          )}
          <span>
            <strong>
              {permissionMode === "confirm"
                ? "变更前确认"
                : permissionMode === "read-only"
                  ? "只读模式"
                  : "完全访问"}
            </strong>
            <small>
              {permissionMode === "confirm"
                ? "写入文件和运行命令前询问"
                : permissionMode === "read-only"
                  ? "仅允许读取和分析工作区"
                  : "可直接写入文件和运行命令"}
            </small>
          </span>
        </div>
      </section>
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
