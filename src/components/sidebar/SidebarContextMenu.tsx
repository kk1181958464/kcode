import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Code2,
  Copy,
  FolderOpen,
  FolderSearch,
  GitFork,
  PencilLine,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { revealLocalPath } from "../../lib/reveal-path";
import { copyWithToast } from "../../lib/toast";
import { localWorkspacePath } from "../../task-workspace";
import type { SidebarTask, SidebarWorkspaceGroup } from "../../models";

export type SidebarDeleteTarget =
  | {
      kind: "workspace";
      workspaceKey: string;
      name: string;
      count: number;
    }
  | { kind: "task"; taskId: string };

export type SidebarContextMenuState =
  | {
      kind: "workspace";
      group: SidebarWorkspaceGroup;
      x: number;
      y: number;
    }
  | { kind: "task"; task: SidebarTask; x: number; y: number };

export type SidebarContextMenuTarget =
  | { kind: "workspace"; group: SidebarWorkspaceGroup }
  | { kind: "task"; task: SidebarTask };

export type SidebarLocalWorkspaceTarget =
  | { kind: "workspace"; workspaceKey: string }
  | { kind: "task"; taskId: string };

type ContextMenuProps = {
  menu: SidebarContextMenuState;
  close(): void;
  toggleWorkspace(workspaceKey: string): void;
  createConversation(workspaceKey: string): void;
  openTaskEditor(taskId: string): void;
  renameTask(taskId: string): void;
  forkTask(taskId: string): void;
  assignLocalWorkspace(target: SidebarLocalWorkspaceTarget): void;
  toggleTaskArchived(taskId: string): void;
  setDeleteTarget(target: SidebarDeleteTarget): void;
};

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick(): void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : ""}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ContextMenu({
  menu,
  close,
  toggleWorkspace,
  createConversation,
  openTaskEditor,
  renameTask,
  forkTask,
  assignLocalWorkspace,
  toggleTaskArchived,
  setDeleteTarget,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const group = menu.kind === "workspace" ? menu.group : undefined;
  const menuTask = menu.kind === "task" ? menu.task : undefined;
  const task = group?.conversations[0] ?? menuTask;
  const projectPath =
    group?.localWorkspacePath ??
    (menuTask ? localWorkspacePath(menuTask) : undefined);
  const cachePath = task?.remoteWorkspace ? task.workspacePath : undefined;
  const remote = task?.remoteWorkspace;
  const title = group?.name ?? menuTask?.name ?? "工作区";
  const detail = remote
    ? `${remote.username}@${remote.host}:${remote.rootPath}`
    : projectPath || "未设置工作区";
  const position = {
    left: Math.max(8, Math.min(menu.x, window.innerWidth - 292)),
    top: Math.max(8, Math.min(menu.y, window.innerHeight - 430)),
  };
  const run = (action: () => void) => {
    close();
    action();
  };
  const openPath = (target: string) =>
    run(() => void revealLocalPath(target, target));
  const copyPath = (target: string, message: string) =>
    run(() => void copyWithToast(target, message));

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, []);

  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="sidebar-context-menu"
      role="menu"
      aria-label={`${title}操作`}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={navigateMenu}
    >
      <div className="sidebar-context-menu-heading">
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      {projectPath ? (
        <>
          <MenuItem
            icon={<FolderOpen size={15} />}
            label="在文件资源管理器中打开项目路径"
            onClick={() => openPath(projectPath)}
          />
          <MenuItem
            icon={<Copy size={14} />}
            label="复制项目路径"
            onClick={() => copyPath(projectPath, "项目路径已复制")}
          />
        </>
      ) : cachePath ? (
        <>
          <MenuItem
            icon={<FolderOpen size={15} />}
            label="打开本地 SSH 缓存目录"
            onClick={() => openPath(cachePath)}
          />
          <MenuItem
            icon={<Copy size={14} />}
            label="复制本地缓存路径"
            onClick={() => copyPath(cachePath, "本地缓存路径已复制")}
          />
        </>
      ) : null}
      {remote && (
        <>
          <MenuItem
            icon={<Server size={14} />}
            label="复制远程项目路径"
            onClick={() => copyPath(remote.rootPath, "远程项目路径已复制")}
          />
        </>
      )}
      <MenuItem
        icon={<FolderSearch size={14} />}
        label={
          remote
            ? projectPath
              ? "更换本地项目目录"
              : "关联本地项目目录"
            : projectPath
              ? "更换项目目录"
              : "选择项目目录"
        }
        onClick={() =>
          run(() =>
            assignLocalWorkspace(
              group
                ? { kind: "workspace", workspaceKey: group.key }
                : { kind: "task", taskId: menuTask!.id },
            ),
          )
        }
      />
      <div className="sidebar-context-menu-separator" />
      {task && (task.workspacePath || task.remoteWorkspace) && (
        <MenuItem
          icon={<Code2 size={15} />}
          label="在编辑器中打开"
          onClick={() => run(() => openTaskEditor(task.id))}
        />
      )}
      {group ? (
        <>
          <MenuItem
            icon={<Plus size={15} />}
            label="在此工作区新建任务"
            onClick={() => run(() => createConversation(group.key))}
          />
          <MenuItem
            icon={<ChevronDown size={15} />}
            label={group.unassigned ? "展开/折叠任务" : "展开/折叠工作区"}
            onClick={() => run(() => toggleWorkspace(group.key))}
          />
          <div className="sidebar-context-menu-separator" />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="删除此工作区的全部对话"
            danger
            onClick={() =>
              run(() =>
                setDeleteTarget({
                  kind: "workspace",
                  workspaceKey: group.key,
                  name: group.name,
                  count: group.conversations.length,
                }),
              )
            }
          />
        </>
      ) : (
        <>
          <MenuItem
            icon={<PencilLine size={14} />}
            label="重命名任务"
            onClick={() => run(() => renameTask(menuTask!.id))}
          />
          <MenuItem
            icon={<GitFork size={14} />}
            label="从此会话创建分支"
            onClick={() => run(() => forkTask(menuTask!.id))}
          />
          <MenuItem
            icon={
              menuTask!.archived ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )
            }
            label={menuTask!.archived ? "移出归档" : "归档对话"}
            onClick={() => run(() => toggleTaskArchived(menuTask!.id))}
          />
          <div className="sidebar-context-menu-separator" />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="删除对话"
            danger
            onClick={() =>
              run(() => setDeleteTarget({ kind: "task", taskId: menuTask!.id }))
            }
          />
        </>
      )}
    </div>
  );
}

export function SidebarContextMenu(props: ContextMenuProps) {
  return createPortal(<ContextMenu {...props} />, document.body);
}
