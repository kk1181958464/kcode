import { memo } from "react";
import {
  MessagesSquare,
  Code2,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Server,
} from "lucide-react";
import type { GitWorkspaceState } from "../../types";
import type { SshRemoteState, SshRemoteWorkspace } from "../../ssh-remote-types";

export interface TopBarProps {
  taskName: string;
  sidebarOpen: boolean;
  setSidebarOpen(updater: (value: boolean) => boolean): void;
  statusOpen: boolean;
  updateStatusPanel(value: boolean): void;
  gitState: GitWorkspaceState;
  remoteWorkspace?: SshRemoteWorkspace;
  remoteState?: SshRemoteState;
  workspaceView: "chat" | "editor";
  setWorkspaceView(value: "chat" | "editor"): void;
}

export const TopBar = memo(function TopBar({
  taskName,
  sidebarOpen,
  setSidebarOpen,
  statusOpen,
  updateStatusPanel,
  gitState,
  remoteWorkspace,
  remoteState,
  workspaceView,
  setWorkspaceView,
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
          {remoteWorkspace ? (
            <span>
              <Server size={13} />
              {remoteWorkspace.username}@{remoteWorkspace.host} <i />
              {remoteState?.connected ? "已连接" : "未连接"}
            </span>
          ) : (
            <span>
              <GitBranch size={13} />{" "}
              {gitState.available ? gitState.branch : "未初始化 Git"} <i />
              {gitState.available
                ? gitState.files
                  ? `${gitState.files} 个文件有变更`
                  : "工作区无未提交变更"
                : gitState.error || "未初始化 Git"}
            </span>
          )}
        </div>
      </div>
      {remoteWorkspace && (
        <div className="workspace-view-switch" role="tablist" aria-label="工作区视图">
          <button
            type="button"
            role="tab"
            aria-selected={workspaceView === "chat"}
            className={workspaceView === "chat" ? "active" : ""}
            onClick={() => setWorkspaceView("chat")}
          >
            <MessagesSquare size={14} />
            对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceView === "editor"}
            className={workspaceView === "editor" ? "active" : ""}
            onClick={() => setWorkspaceView("editor")}
          >
            <Code2 size={14} />
            编辑器
          </button>
        </div>
      )}
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
