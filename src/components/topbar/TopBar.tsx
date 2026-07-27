import { memo } from "react";
import {
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type { GitWorkspaceState } from "../../types";

export interface TopBarProps {
  taskName: string;
  sidebarOpen: boolean;
  setSidebarOpen(updater: (value: boolean) => boolean): void;
  statusOpen: boolean;
  updateStatusPanel(value: boolean): void;
  gitState: GitWorkspaceState;
}

export const TopBar = memo(function TopBar({
  taskName,
  sidebarOpen,
  setSidebarOpen,
  statusOpen,
  updateStatusPanel,
  gitState,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon pane-toggle"
          onClick={() => setSidebarOpen((value) => !value)}
          title={sidebarOpen ? "收起导航" : "展开导航"}
        >
          {sidebarOpen ? (
            <PanelLeftClose size={17} />
          ) : (
            <PanelLeftOpen size={17} />
          )}
        </button>
        <div>
          <h1>{taskName}</h1>
          <span>
            <GitBranch size={13} />{" "}
            {gitState.available ? gitState.branch : "未初始化 Git"} <i />
            {gitState.available
              ? gitState.files
                ? `${gitState.files} 个文件有变更`
                : "工作区无未提交变更"
              : gitState.error || "未初始化 Git"}
          </span>
        </div>
      </div>
      <div className="top-actions">
        <button
          className="icon framed status-toggle"
          onClick={() => updateStatusPanel(!statusOpen)}
          title={statusOpen ? "收起状态栏" : "展开状态栏"}
        >
          {statusOpen ? (
            <PanelRightClose size={17} />
          ) : (
            <PanelRightOpen size={17} />
          )}
        </button>
      </div>
    </header>
  );
});
