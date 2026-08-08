import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  Bot,
  FolderOpen,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type {
  AgentCheckpoint,
  AgentRuntimeInfo,
  ManagedProcessInfo,
} from "../../types";
import { errorMessage } from "../../lib/format";

const runtimeStatusLabels: Record<string, string> = {
  not_loaded: "未加载",
  idle: "空闲",
  running: "运行中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

export function RuntimeSettings() {
  const [processes, setProcesses] = useState<ManagedProcessInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [runs, setRuns] = useState<AgentRuntimeInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!window.kcode?.runtime) return;
    setError("");
    try {
      // Keep the settings page usable while an older preload is still loaded.
      const runtimeStatuses = window.kcode.runtime.statuses
        ? window.kcode.runtime.statuses()
        : Promise.resolve<AgentRuntimeInfo[]>([]);
      const [active, saved, runtimeRuns] = await Promise.all([
        window.kcode.runtime.processes(),
        window.kcode.chat.checkpoints(),
        runtimeStatuses,
      ]);
      setProcesses(active);
      setCheckpoints(saved);
      setRuns(runtimeRuns);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function stopProcess(id: string) {
    setBusy(true);
    try {
      setProcesses(await window.kcode.runtime.stopProcess(id));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function clearCheckpoint(id: string) {
    setBusy(true);
    try {
      await window.kcode.chat.removeCheckpoint(id);
      setCheckpoints((items) => items.filter((item) => item.id !== id));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function stopAllProcesses() {
    setBusy(true);
    setError("");
    try {
      setProcesses(await window.kcode.runtime.stopAll());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section runtime-settings-section">
      <div className="settings-section-header with-action">
        <div>
          <h3>运行与恢复</h3>
          <p>查看后台进程和中断后可恢复的 Agent 记录。</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      {error && (
        <div className="settings-inline-error">
          <CircleAlert size={14} />
          {error}
        </div>
      )}
      <div className="runtime-settings-grid">
        <div className="settings-group runtime-group">
          <header>
            <span>
              <Bot size={15} />
              <strong>Agent 运行时</strong>
            </span>
            <small>{runs.filter((run) => run.active).length} 个活动</small>
          </header>
          {runs.length ? (
            runs.slice(0, 20).map((run) => (
              <div className="runtime-row" key={run.requestId}>
                <span>
                  <strong>
                    {runtimeStatusLabels[run.threadStatus] ?? run.threadStatus}
                  </strong>
                  <small title={run.requestId}>
                    {run.taskId} · #{run.lastSequence}
                  </small>
                </span>
                <time>{new Date(run.updatedAt).toLocaleString()}</time>
                <i className={run.active ? "runtime-online" : "runtime-idle"} />
              </div>
            ))
          ) : (
            <div className="settings-empty">当前没有 Agent 运行记录</div>
          )}
        </div>
        <div className="settings-group runtime-group">
          <header>
            <span>
              <Terminal size={15} />
              <strong>后台进程</strong>
            </span>
            <small>{processes.length} 个</small>
          </header>
          {processes.length ? (
            processes.map((process) => (
              <div className="runtime-row" key={process.id}>
                <span>
                  <strong>PID {process.pid}</strong>
                  <small title={process.workspacePath}>
                    {process.workspacePath}
                  </small>
                </span>
                <time>{new Date(process.startedAt).toLocaleString()}</time>
                <button
                  className="icon danger"
                  title="停止进程"
                  disabled={busy}
                  onClick={() => void stopProcess(process.id)}
                >
                  <Square size={12} />
                </button>
              </div>
            ))
          ) : (
            <div className="settings-empty">没有 KCode 管理的后台进程</div>
          )}
          {processes.length > 1 && (
            <button
              className="secondary danger-text"
              disabled={busy}
              onClick={() => void stopAllProcesses()}
            >
              <Square size={13} />
              全部停止
            </button>
          )}
        </div>
        <div className="settings-group runtime-group">
          <header>
            <span>
              <RefreshCw size={15} />
              <strong>恢复记录</strong>
            </span>
            <small>{checkpoints.length} 个</small>
          </header>
          {checkpoints.length ? (
            checkpoints.map((checkpoint) => (
              <div className="runtime-row" key={checkpoint.id}>
                <span>
                  <strong>{checkpoint.request.modelId}</strong>
                  <small>{checkpoint.request.workspacePath}</small>
                </span>
                <time>{new Date(checkpoint.startedAt).toLocaleString()}</time>
                <button
                  className="icon danger"
                  title="删除恢复记录"
                  disabled={busy}
                  onClick={() => void clearCheckpoint(checkpoint.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="settings-empty">没有中断恢复记录</div>
          )}
        </div>
      </div>
      <button
        className="secondary runtime-log-button"
        onClick={() => void window.kcode.logs.reveal()}
      >
        <FolderOpen size={14} />
        打开诊断日志
      </button>
    </section>
  );
}
