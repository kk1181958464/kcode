import { memo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FolderOpen,
  GripVertical,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import appLogo from "../../../build/icon.png";
import { errorMessage } from "../../lib/format";
import type { TaskRecord } from "../../models";
import type { SettingsSection } from "../../models";

interface WorkspaceGroup {
  workspacePath: string;
  name: string;
  conversations: TaskRecord[];
}

export interface SidebarProps {
  workspaceGroups: WorkspaceGroup[];
  activeTask: TaskRecord | undefined;
  taskQuery: string;
  setTaskQuery(value: string): void;
  showArchived: boolean;
  setShowArchived(updater: (value: boolean) => boolean): void;
  collapsedWorkspaces: Set<string>;
  startNewTask(): void;
  reorderWorkspace(sourcePath: string | undefined, targetPath: string): void;
  reorderTask(sourceId: string | undefined, targetId: string): void;
  toggleWorkspace(workspacePath: string): void;
  createConversation(workspacePath: string): void;
  switchTask(taskId: string): void;
  toggleTaskArchived(taskId: string): void;
  setDeleteTarget(
    target:
      | { kind: "workspace"; path: string; name: string; count: number }
      | { kind: "task"; task: TaskRecord },
  ): void;
  setContextError(message: string): void;
  openSettings(section: SettingsSection): void;
  startSidebarResize(event: React.PointerEvent): void;
}
export const Sidebar = memo(function Sidebar({
  workspaceGroups,
  activeTask,
  taskQuery,
  setTaskQuery,
  showArchived,
  setShowArchived,
  collapsedWorkspaces,
  startNewTask,
  reorderWorkspace,
  reorderTask,
  toggleWorkspace,
  createConversation,
  switchTask,
  toggleTaskArchived,
  setDeleteTarget,
  setContextError,
  openSettings,
  startSidebarResize,
}: SidebarProps) {
  // Drag-and-drop is purely Sidebar-internal UI state — kept here rather than
  // drilled from App (8 fewer props) so it never triggers App re-renders.
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [taskDropTarget, setTaskDropTarget] = useState<string>();
  const [draggedWorkspace, setDraggedWorkspace] = useState<string>();
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<string>();
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src={appLogo} alt="" aria-hidden="true" />
        <div>
          <strong>KCode</strong>
          <small>Agent workspace</small>
        </div>
      </div>
      <button className="new-task" onClick={() => void startNewTask()}>
        <span className="new-task-icon">
          <Plus size={15} />
        </span>
        <span>新建任务</span>
        <kbd>Ctrl N</kbd>
      </button>
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
      <div className="workspace-tree">
        {workspaceGroups.map((group) => (
          <section
            className={`workspace-group ${draggedWorkspace === group.workspacePath ? "dragging" : ""} ${workspaceDropTarget === group.workspacePath && draggedWorkspace !== group.workspacePath ? "drop-target" : ""}`}
            key={group.workspacePath}
            draggable
            onDragStart={(event) => {
              if ((event.target as HTMLElement).closest(".task-row")) return;
              setDraggedWorkspace(group.workspacePath);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", group.workspacePath);
            }}
            onDragOver={(event) => {
              if (!draggedWorkspace) return;
              event.preventDefault();
              setWorkspaceDropTarget(group.workspacePath);
            }}
            onDrop={(event) => {
              if (!draggedWorkspace) return;
              event.preventDefault();
              reorderWorkspace(draggedWorkspace, group.workspacePath);
              setDraggedWorkspace(undefined);
              setWorkspaceDropTarget(undefined);
            }}
            onDragEnd={() => {
              setDraggedWorkspace(undefined);
              setWorkspaceDropTarget(undefined);
            }}
          >
            <header
              title={group.workspacePath}
              className="workspace-header"
              onClick={() => toggleWorkspace(group.workspacePath)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void window.kcode?.workspace
                  .showFolderMenu(group.workspacePath)
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
                className="workspace-collapse"
                title={
                  collapsedWorkspaces.has(group.workspacePath)
                    ? "展开对话"
                    : "折叠对话"
                }
                aria-expanded={!collapsedWorkspaces.has(group.workspacePath)}
              >
                <ChevronDown size={13} />
              </span>
              <FolderOpen size={15} />
              <span className="workspace-name">{group.name}</span>
              <small>{group.conversations.length}</small>
              <button
                title={`在 ${group.name} 新建对话`}
                onClick={(event) => {
                  event.stopPropagation();
                  void createConversation(group.workspacePath);
                }}
              >
                <Plus size={14} />
              </button>
              <button
                className="workspace-delete"
                title={`删除 ${group.name} 的全部对话记录`}
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget({
                    kind: "workspace",
                    path: group.workspacePath,
                    name: group.name,
                    count: group.conversations.length,
                  });
                }}
              >
                <Trash2 size={13} />
              </button>
            </header>
            <div
              className={`tasks ${collapsedWorkspaces.has(group.workspacePath) ? "collapsed" : ""}`}
              aria-hidden={collapsedWorkspaces.has(group.workspacePath)}
            >
              {group.conversations.map((task) => (
                <div
                  key={task.id}
                  draggable
                  className={`task-row ${task.id === activeTask?.id ? "active" : ""} ${draggedTaskId === task.id ? "dragging" : ""} ${taskDropTarget === task.id && draggedTaskId !== task.id ? "drop-target" : ""}`}
                  title={`${task.name}\n${task.workspacePath}`}
                  onDragStart={(event) => {
                    event.stopPropagation();
                    setDraggedTaskId(task.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", task.id);
                  }}
                  onDragOver={(event) => {
                    if (!draggedTaskId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setTaskDropTarget(task.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    reorderTask(draggedTaskId, task.id);
                    setDraggedTaskId(undefined);
                    setTaskDropTarget(undefined);
                  }}
                  onDragEnd={(event) => {
                    event.stopPropagation();
                    setDraggedTaskId(undefined);
                    setTaskDropTarget(undefined);
                  }}
                >
                  <span className="task-grip" title="拖动排序">
                    <GripVertical size={13} />
                  </span>
                  <button
                    className="task-main"
                    onClick={() => void switchTask(task.id)}
                  >
                    <span>{task.name}</span>
                  </button>
                  {(task.runningId || task.runStatus === "running") && (
                    <small className="task-running">运行中</small>
                  )}
                  <button
                    className="task-archive"
                    title={task.archived ? "移出归档" : "归档对话"}
                    onClick={() => toggleTaskArchived(task.id)}
                  >
                    {task.archived ? (
                      <ArchiveRestore size={13} />
                    ) : (
                      <Archive size={13} />
                    )}
                  </button>
                  <button
                    className="task-delete"
                    title={`删除对话 ${task.name}`}
                    onClick={() => setDeleteTarget({ kind: "task", task })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
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
}, sidebarPropsEqual);

function sidebarPropsEqual(previous: SidebarProps, next: SidebarProps) {
  if (
    previous.activeTask?.id !== next.activeTask?.id ||
    previous.taskQuery !== next.taskQuery ||
    previous.showArchived !== next.showArchived ||
    previous.workspaceGroups.length !== next.workspaceGroups.length ||
    previous.collapsedWorkspaces.size !== next.collapsedWorkspaces.size
  )
    return false;

  for (const path of previous.collapsedWorkspaces)
    if (!next.collapsedWorkspaces.has(path)) return false;

  for (let groupIndex = 0; groupIndex < previous.workspaceGroups.length; groupIndex += 1) {
    const previousGroup = previous.workspaceGroups[groupIndex];
    const nextGroup = next.workspaceGroups[groupIndex];
    if (
      previousGroup.workspacePath !== nextGroup.workspacePath ||
      previousGroup.name !== nextGroup.name ||
      previousGroup.conversations.length !== nextGroup.conversations.length
    )
      return false;

    for (let taskIndex = 0; taskIndex < previousGroup.conversations.length; taskIndex += 1) {
      const previousTask = previousGroup.conversations[taskIndex];
      const nextTask = nextGroup.conversations[taskIndex];
      if (
        previousTask.id !== nextTask.id ||
        previousTask.name !== nextTask.name ||
        previousTask.workspacePath !== nextTask.workspacePath ||
        previousTask.archived !== nextTask.archived ||
        previousTask.runningId !== nextTask.runningId ||
        previousTask.runStatus !== nextTask.runStatus
      )
        return false;
    }
  }

  return true;
}
