import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  FolderOpen,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type { AgentCheckpoint, ManagedProcessInfo } from "../../types";
import { errorMessage } from "../../lib/format";

export function RuntimeSettings() {
  const [processes, setProcesses] = useState<ManagedProcessInfo[]>([]);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!window.kcode?.runtime) return;
    setError("");
    try {
      const [active, saved] = await Promise.all([
        window.kcode.runtime.processes(),
        window.kcode.chat.checkpoints(),
      ]);
      setProcesses(active);
      setCheckpoints(saved);
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
