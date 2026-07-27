import {
  CheckCircle2,
  CircleAlert,
  CloudDownload,
  Download,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import type { AppUpdateState } from "../../types";
import { LinkifiedText } from "../common/LinkifiedText";
import { openExternalUrl } from "../common/external";

const updateBytes = (value = 0) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

export function AppUpdateDialog({
  state,
  onClose,
}: {
  state: AppUpdateState;
  onClose(): void;
}) {
  const progress = Math.max(0, Math.min(100, state.progress?.percent || 0));
  const checking = state.status === "checking" || state.status === "idle";
  return (
    <div
      className="modal-backdrop update-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="update-dialog" role="dialog" aria-modal="true">
        <header>
          <span className="update-dialog-icon">
            <CloudDownload size={18} />
          </span>
          <div>
            <h2>应用更新</h2>
            <small>当前版本 {state.currentVersion || "-"}</small>
          </div>
          <button className="icon" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="update-dialog-body">
          {checking && (
            <div className="update-message">
              <RefreshCw className="spin" size={22} />
              <strong>正在检查更新</strong>
              <span>正在连接 GitHub Release…</span>
            </div>
          )}
          {state.status === "available" && (
            <div className="update-content">
              <strong>发现新版本 {state.version}</strong>
              <span>下载完成后可直接重启安装。</span>
              {state.releaseNotes && (
                <pre className="update-notes">{state.releaseNotes}</pre>
              )}
            </div>
          )}
          {state.status === "downloading" && (
            <div className="update-content">
              <strong>正在下载 {state.version}</strong>
              <span>
                {updateBytes(state.progress?.transferred)} /{" "}
                {updateBytes(state.progress?.total)} ·{" "}
                {updateBytes(state.progress?.bytesPerSecond)}/s
              </span>
              <div className="update-progress">
                <i style={{ width: `${progress}%` }} />
              </div>
              <small>{progress.toFixed(0)}%</small>
            </div>
          )}
          {state.status === "downloaded" && (
            <div className="update-message success">
              <CheckCircle2 size={22} />
              <strong>版本 {state.version} 已准备好</strong>
              <span>重启后自动完成安装。</span>
            </div>
          )}
          {state.status === "not-available" && (
            <div className="update-message success">
              <CheckCircle2 size={22} />
              <strong>当前已是最新版本</strong>
              <span>版本 {state.currentVersion}</span>
            </div>
          )}
          {state.status === "unsupported" && (
            <div className="update-message warning">
              <CircleAlert size={22} />
              <strong>
                {state.portable
                  ? "便携版不支持自动覆盖安装"
                  : "开发环境不执行在线更新"}
              </strong>
              <span>可以前往 GitHub Release 下载正式安装版。</span>
            </div>
          )}
          {state.status === "error" && (
            <div className="update-message warning">
              <CircleAlert size={22} />
              <strong>更新失败</strong>
              <span>{state.error || "请稍后重试"}</span>
            </div>
          )}
        </div>
        <footer>
          {(state.status === "unsupported" || state.status === "error") && (
            <button onClick={() => void window.kcode.updater.openRelease()}>
              <ExternalLink size={14} />
              查看 Release
            </button>
          )}
          {state.status === "available" && (
            <button
              className="primary"
              onClick={() => void window.kcode.updater.download()}
            >
              <Download size={14} />
              下载更新
            </button>
          )}
          {state.status === "downloaded" && (
            <button
              className="primary"
              onClick={() => void window.kcode.updater.install()}
            >
              <RefreshCw size={14} />
              重启并安装
            </button>
          )}
          {["not-available", "error"].includes(state.status) && (
            <button
              className="primary"
              onClick={() => void window.kcode.updater.check()}
            >
              <RefreshCw size={14} />
              重新检查
            </button>
          )}
          <button onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}
