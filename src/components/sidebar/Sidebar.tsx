import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderOpen,
  GripVertical,
  Plus,
  PanelLeftClose,
  Search,
  Server,
  Settings,
  Trash2,
} from "lucide-react";
import appLogo from "../../../build/icon.png";
import { errorMessage } from "../../lib/format";
import { sidebarTaskRenderKey } from "../../sidebar-projection";
import type {
  SettingsSection,
  SidebarTask,
  SidebarWorkspaceGroup,
} from "../../models";

type SidebarRow =
  | { kind: "workspace"; group: SidebarWorkspaceGroup }
  | { kind: "task"; task: SidebarTask };

const virtuosoComponents = {
  Footer: () => <div className="workspace-tree-footer" aria-hidden="true" />,
};

function sidebarRowKey(_: number, row: SidebarRow) {
  return row.kind === "workspace"
    ? `workspace:${row.group.workspacePath}`
    : sidebarTaskRenderKey(row.task);
}

export interface SidebarProps {
  workspaceGroups: SidebarWorkspaceGroup[];
  taskStorageReady: boolean;
  activeTaskId?: string;
  taskQuery: string;
  setTaskQuery(value: string): void;
  showArchived: boolean;
  setShowArchived(updater: (value: boolean) => boolean): void;
  collapsedWorkspaces: Set<string>;
  startNewTask(): void;
  startSshRemote(): void;
  reorderWorkspace(sourcePath: string | undefined, targetPath: string): void;
  reorderTask(sourceId: string | undefined, targetId: string): void;
  toggleWorkspace(workspacePath: string): void;
  createConversation(workspacePath: string): void;
  switchTask(taskId: string): void;
  toggleTaskArchived(taskId: string): void;
  setDeleteTarget(
    target:
      | { kind: "workspace"; path: string; name: string; count: number }
      | { kind: "task"; taskId: string },
  ): void;
  setContextError(message: string): void;
  openSettings(section: SettingsSection): void;
  closeSidebar(): void;
  startSidebarResize(event: React.PointerEvent): void;
}

export const Sidebar = memo(function Sidebar({
  workspaceGroups,
  taskStorageReady,
  activeTaskId,
  taskQuery,
  setTaskQuery,
  showArchived,
  setShowArchived,
  collapsedWorkspaces,
  startNewTask,
  startSshRemote,
  reorderWorkspace,
  reorderTask,
  toggleWorkspace,
  createConversation,
  switchTask,
  toggleTaskArchived,
  setDeleteTarget,
  setContextError,
  openSettings,
  closeSidebar,
  startSidebarResize,
}: SidebarProps) {
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [taskDropTarget, setTaskDropTarget] = useState<string>();
  const [draggedWorkspace, setDraggedWorkspace] = useState<string>();
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<string>();
  const workspaceTreeRef = useRef<HTMLElement | null>(null);
  const draggedTaskIdRef = useRef<string | undefined>(undefined);
  const draggedWorkspaceRef = useRef<string | undefined>(undefined);
  const pendingTaskDropTargetRef = useRef<string | undefined>(undefined);
  const pendingWorkspaceDropTargetRef = useRef<string | undefined>(undefined);
  const taskDropFrameRef = useRef<number | undefined>(undefined);
  const workspaceDropFrameRef = useRef<number | undefined>(undefined);
  const rows = useMemo<SidebarRow[]>(() => {
    const next: SidebarRow[] = [];
    for (const group of workspaceGroups) {
      next.push({ kind: "workspace", group });
      if (!collapsedWorkspaces.has(group.workspacePath))
        for (const task of group.conversations)
          next.push({ kind: "task", task });
    }
    return next;
  }, [collapsedWorkspaces, workspaceGroups]);
  const setWorkspaceTreeRef = useCallback(
    (element: HTMLElement | Window | null) => {
      workspaceTreeRef.current =
        element instanceof HTMLElement ? element : null;
    },
    [],
  );
  const handleListScrolling = useCallback((isScrolling: boolean) => {
    workspaceTreeRef.current?.classList.toggle("scrolling", isScrolling);
  }, []);

  const scheduleTaskDropTarget = (taskId: string) => {
    if (pendingTaskDropTargetRef.current === taskId) return;
    pendingTaskDropTargetRef.current = taskId;
    if (taskDropFrameRef.current !== undefined) return;
    taskDropFrameRef.current = requestAnimationFrame(() => {
      taskDropFrameRef.current = undefined;
      setTaskDropTarget(pendingTaskDropTargetRef.current);
    });
  };
  const scheduleWorkspaceDropTarget = (workspacePath: string) => {
    if (pendingWorkspaceDropTargetRef.current === workspacePath) return;
    pendingWorkspaceDropTargetRef.current = workspacePath;
    if (workspaceDropFrameRef.current !== undefined) return;
    workspaceDropFrameRef.current = requestAnimationFrame(() => {
      workspaceDropFrameRef.current = undefined;
      setWorkspaceDropTarget(pendingWorkspaceDropTargetRef.current);
    });
  };
  const finishTaskDrag = useCallback(() => {
    draggedTaskIdRef.current = undefined;
    pendingTaskDropTargetRef.current = undefined;
    if (taskDropFrameRef.current !== undefined) {
      cancelAnimationFrame(taskDropFrameRef.current);
      taskDropFrameRef.current = undefined;
    }
    setDraggedTaskId(undefined);
    setTaskDropTarget(undefined);
  }, []);
  const finishWorkspaceDrag = useCallback(() => {
    draggedWorkspaceRef.current = undefined;
    pendingWorkspaceDropTargetRef.current = undefined;
    if (workspaceDropFrameRef.current !== undefined) {
      cancelAnimationFrame(workspaceDropFrameRef.current);
      workspaceDropFrameRef.current = undefined;
    }
    setDraggedWorkspace(undefined);
    setWorkspaceDropTarget(undefined);
  }, []);
  useEffect(() => {
    const finishAllDrags = () => {
      finishTaskDrag();
      finishWorkspaceDrag();
    };
    const finishHiddenDrag = () => {
      if (document.hidden) finishAllDrags();
    };

    window.addEventListener("dragend", finishAllDrags);
    window.addEventListener("drop", finishAllDrags);
    window.addEventListener("blur", finishAllDrags);
    document.addEventListener("visibilitychange", finishHiddenDrag);

    return () => {
      window.removeEventListener("dragend", finishAllDrags);
      window.removeEventListener("drop", finishAllDrags);
      window.removeEventListener("blur", finishAllDrags);
      document.removeEventListener("visibilitychange", finishHiddenDrag);
      if (taskDropFrameRef.current !== undefined)
        cancelAnimationFrame(taskDropFrameRef.current);
      if (workspaceDropFrameRef.current !== undefined)
        cancelAnimationFrame(workspaceDropFrameRef.current);
      workspaceTreeRef.current?.classList.remove("scrolling");
    };
  }, [finishTaskDrag, finishWorkspaceDrag]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src={appLogo} alt="" aria-hidden="true" />
        <div>
          <strong>KCode</strong>
          <small>Agent workspace</small>
        </div>
        <button
          type="button"
          className="sidebar-mobile-close"
          title="关闭导航抽屉"
          aria-label="关闭导航抽屉"
          onClick={closeSidebar}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="new-task-actions">
        <button
          className="new-task"
          disabled={!taskStorageReady}
          onClick={() => void startNewTask()}
        >
          <span className="new-task-icon">
            <Plus size={15} />
          </span>
          <span>新建任务</span>
          <kbd>Ctrl N</kbd>
        </button>
        <button
          type="button"
          className="new-ssh-remote"
          title="新建 SSH Remote 任务"
          aria-label="新建 SSH Remote 任务"
          disabled={!taskStorageReady}
          onClick={startSshRemote}
        >
          <Server size={15} />
        </button>
      </div>
      <div className="workspace-label">工作区与对话</div>
      <div className="task-filter">
        <Search size={13} />
        <input
          value={taskQuery}
          onChange={(event) => setTaskQuery(event.target.value)}
          placeholder="搜索任务"
          aria-label="搜索任务"
        />
        <button
          className={showArchived ? "active" : ""}
          title={showArchived ? "显示当前任务" : "显示已归档任务"}
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
      </div>
      <Virtuoso
        className="workspace-tree"
        data={rows}
        fixedItemHeight={34}
        increaseViewportBy={560}
        overscan={340}
        isScrolling={handleListScrolling}
        scrollerRef={setWorkspaceTreeRef}
        components={virtuosoComponents}
        computeItemKey={sidebarRowKey}
        itemContent={(_, row) =>
          row.kind === "workspace" ? (
            <div
              className={`workspace-flat-row ${draggedWorkspace === row.group.workspacePath ? "dragging" : ""} ${workspaceDropTarget === row.group.workspacePath && draggedWorkspace !== row.group.workspacePath ? "drop-target" : ""}`}
              draggable
              onDragStart={(event) => {
                draggedWorkspaceRef.current = row.group.workspacePath;
                setDraggedWorkspace(row.group.workspacePath);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "text/plain",
                  row.group.workspacePath,
                );
              }}
              onDragOver={(event) => {
                if (!draggedWorkspaceRef.current) return;
                event.preventDefault();
                scheduleWorkspaceDropTarget(row.group.workspacePath);
              }}
              onDrop={(event) => {
                const sourcePath = draggedWorkspaceRef.current;
                if (!sourcePath) return;
                event.preventDefault();
                reorderWorkspace(sourcePath, row.group.workspacePath);
                finishWorkspaceDrag();
              }}
              onDragEnd={finishWorkspaceDrag}
            >
              <header
                title={row.group.workspacePath}
                className="workspace-header"
                onClick={() => toggleWorkspace(row.group.workspacePath)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void window.kcode?.workspace
                    .showFolderMenu(row.group.workspacePath)
                    .catch((error: unknown) =>
                      setContextError(
                        `无法打开文件夹菜单：${errorMessage(error)}`,
                      ),
                    );
                }}
              >
                <span
                  className="workspace-grip"
                  title="拖动工作区排序"
                  onClick={(event) => event.stopPropagation()}
                >
                  <GripVertical size={13} />
                </span>
                <span
                  className={`workspace-collapse ${collapsedWorkspaces.has(row.group.workspacePath) ? "collapsed" : ""}`}
                  title={
                    collapsedWorkspaces.has(row.group.workspacePath)
                      ? "展开对话"
                      : "折叠对话"
                  }
                  aria-expanded={
                    !collapsedWorkspaces.has(row.group.workspacePath)
                  }
                >
                  <ChevronDown size={13} />
                </span>
                {row.group.remote ? (
                  <Server size={15} />
                ) : (
                  <FolderOpen size={15} />
                )}
                <span className="workspace-name">{row.group.name}</span>
                <small>{row.group.conversations.length}</small>
                <button
                  title={`在 ${row.group.name} 新建对话`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void createConversation(
                      row.group.conversations[0]?.workspacePath ??
                        row.group.workspacePath,
                    );
                  }}
                >
                  <Plus size={14} />
                </button>
                <button
                  className="workspace-delete"
                  title={`删除 ${row.group.name} 的全部对话记录`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTarget({
                      kind: "workspace",
                      path: row.group.workspacePath,
                      name: row.group.name,
                      count: row.group.conversations.length,
                    });
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </header>
            </div>
          ) : (
            <div
              draggable
              role="button"
              tabIndex={0}
              className={`task-row task-flat-row ${row.task.id === activeTaskId ? "active" : ""} ${draggedTaskId === row.task.id ? "dragging" : ""} ${taskDropTarget === row.task.id && draggedTaskId !== row.task.id ? "drop-target" : ""}`}
              title={`${row.task.name}\n${row.task.workspacePath}`}
              onClick={(event) => {
                if (
                  draggedTaskId ||
                  (event.target as HTMLElement).closest("button, .task-grip")
                )
                  return;
                void switchTask(row.task.id);
                if (window.matchMedia("(max-width: 620px)").matches)
                  closeSidebar();
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void switchTask(row.task.id);
                  if (window.matchMedia("(max-width: 620px)").matches)
                    closeSidebar();
                }
              }}
              onDragStart={(event) => {
                event.stopPropagation();
                draggedTaskIdRef.current = row.task.id;
                setDraggedTaskId(row.task.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", row.task.id);
              }}
              onDragOver={(event) => {
                if (!draggedTaskIdRef.current) return;
                event.preventDefault();
                event.stopPropagation();
                scheduleTaskDropTarget(row.task.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                reorderTask(draggedTaskIdRef.current, row.task.id);
                finishTaskDrag();
              }}
              onDragEnd={finishTaskDrag}
            >
              <span className="task-grip" title="拖动排序">
                <GripVertical size={13} />
              </span>
              <div className="task-main">
                <span>{row.task.name}</span>
              </div>
              {(row.task.runningId || row.task.runStatus === "running") && (
                <small className="task-running">运行中</small>
              )}
              {!row.task.runningId && row.task.runStatus === "blocked" && (
                <small className="task-blocked">待补充</small>
              )}
              <button
                className="task-archive"
                title={row.task.archived ? "移出归档" : "归档对话"}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleTaskArchived(row.task.id);
                }}
              >
                {row.task.archived ? (
                  <ArchiveRestore size={13} />
                ) : (
                  <Archive size={13} />
                )}
              </button>
              <button
                className="task-delete"
                title={`删除对话 ${row.task.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget({ kind: "task", taskId: row.task.id });
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        }
      />
      <div className="sidebar-footer">
        <button onClick={() => openSettings("general")}>
          <Settings size={17} />
          设置
        </button>
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整任务列表宽度"
        onPointerDown={startSidebarResize}
      />
    </aside>
  );
});
