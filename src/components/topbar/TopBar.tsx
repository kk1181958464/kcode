import { memo, useEffect, useRef, useState } from "react";
import {
  Braces,
  FileText,
  MessagesSquare,
  Code2,
  GitBranch,
  GitFork,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Server,
} from "lucide-react";
import type { GitWorkspaceState } from "../../types";
import type {
  SshRemoteState,
  SshRemoteWorkspace,
} from "../../ssh-remote-types";

export interface TopBarProps {
  taskName: string;
  sidebarOpen: boolean;
  setSidebarOpen(updater: (value: boolean) => boolean): void;
  statusOpen: boolean;
  updateStatusPanel(value: boolean): void;
  gitState: GitWorkspaceState;
  remoteWorkspace?: SshRemoteWorkspace;
  remoteState?: SshRemoteState;
  editorAvailable: boolean;
  workspaceView: "chat" | "editor";
  setWorkspaceView(value: "chat" | "editor"): void;
  forkTask(): void;
  exportTask(format: "md" | "json"): void;
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
  editorAvailable,
  workspaceView,
  setWorkspaceView,
  forkTask,
  exportTask,
}: TopBarProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: PointerEvent) => {
      if (!exportRef.current?.contains(event.target as Node))
        setExportOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [exportOpen]);

  const chooseExport = (format: "md" | "json") => {
    setExportOpen(false);
    exportTask(format);
  };

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
      {editorAvailable && (
        <div
          className="workspace-view-switch"
          role="tablist"
          aria-label="工作区视图"
        >
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
          className="icon framed"
          onClick={forkTask}
          title="从当前会话创建分支"
          aria-label="从当前会话创建分支"
        >
          <GitFork size={16} />
        </button>
        <div className="topbar-export" ref={exportRef}>
          <button
            className="icon framed"
            onClick={() => setExportOpen((value) => !value)}
            title="导出当前会话"
            aria-label="导出当前会话"
            aria-expanded={exportOpen}
            aria-haspopup="menu"
          >
            <Download size={16} />
          </button>
          {exportOpen && (
            <div className="topbar-export-menu" role="menu">
              <button role="menuitem" onClick={() => chooseExport("md")}>
                <FileText size={15} />
                <div>
                  <strong>Markdown</strong>
                  <small>便于阅读和归档</small>
                </div>
              </button>
              <button role="menuitem" onClick={() => chooseExport("json")}>
                <Braces size={15} />
                <div>
                  <strong>JSON</strong>
                  <small>保留完整任务数据</small>
                </div>
              </button>
            </div>
          )}
        </div>
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
