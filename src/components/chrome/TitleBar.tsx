import { CloudDownload, Minus, Square, X } from "lucide-react";
import type { AppUpdateState } from "../../types";

export interface TitleBarProps {
  appUpdate: AppUpdateState;
  setUpdateOpen(value: boolean): void;
}

export function TitleBar({ appUpdate, setUpdateOpen }: TitleBarProps) {
  return (
    <header className="window-titlebar" aria-label="窗口标题栏">
      <span>KCode</span>
      <div className="window-controls">
        <button
          className={`window-update ${["available", "downloading", "downloaded"].includes(appUpdate.status) ? "has-update" : ""}`}
          title={
            ["available", "downloading", "downloaded"].includes(
              appUpdate.status,
            )
              ? `发现新版本 ${appUpdate.version || ""}`
              : "检查更新"
          }
          aria-label="应用更新"
          onClick={() => {
            setUpdateOpen(true);
            if (["idle", "not-available", "error"].includes(appUpdate.status))
              void window.kcode.updater.check();
          }}
        >
          <CloudDownload size={14} />
          {["available", "downloaded"].includes(appUpdate.status) && <i />}
        </button>
        <button
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.kcode.window.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          title="最大化或还原"
          aria-label="最大化或还原"
          onClick={() => void window.kcode.window.toggleMaximize()}
        >
          <Square size={11} />
        </button>
        <button
          className="window-close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.kcode.window.close()}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
