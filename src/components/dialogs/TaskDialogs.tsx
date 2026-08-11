import { FolderOpen, FolderSearch, Trash2, X } from "lucide-react";
import type { TaskRecord } from "../../models";

interface PendingFolder {
  name: string;
  path: string;
}

type DeleteTarget =
  | { kind: "workspace"; path: string; name: string; count: number }
  | { kind: "task"; task: TaskRecord };

export interface NewTaskDialogProps {
  pendingFolder?: PendingFolder | null;
  newTaskName: string;
  setNewTaskName(value: string): void;
  createTask(): Promise<void>;
  onPickFolder(): void;
  onClose(): void;
}

export function NewTaskDialog({
  pendingFolder,
  newTaskName,
  setNewTaskName,
  createTask,
  onPickFolder,
  onClose,
}: NewTaskDialogProps) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal task-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <header>
          <div>
            <span className="eyebrow">新建任务</span>
            <h2 id="new-task-title">命名任务</h2>
          </div>
          <button className="icon" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <label className="task-name-field">
          任务名称
          <input
            autoFocus
            value={newTaskName}
            onChange={(event) => setNewTaskName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void createTask()}
            placeholder={pendingFolder?.name ?? "新任务"}
            maxLength={80}
          />
        </label>
        {pendingFolder ? (
          <div className="selected-folder">
            <FolderOpen size={16} />
            <span>
              <strong>{pendingFolder.name}</strong>
              <small>{pendingFolder.path}</small>
            </span>
            <button
              className="icon folder-change-btn"
              onClick={onPickFolder}
              title="更换文件夹"
            >
              <FolderSearch size={14} />
            </button>
          </div>
        ) : (
          <button className="pick-folder-btn" onClick={onPickFolder}>
            <FolderSearch size={15} />
            选择工作区文件夹
          </button>
        )}
        <footer className="task-modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void createTask()}>
            创建任务
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface AssignFolderDialogProps {
  taskName: string;
  onPickFolder(): void;
  onClose(): void;
}

export function AssignFolderDialog({
  taskName,
  onPickFolder,
  onClose,
}: AssignFolderDialogProps) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal task-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="assign-folder-title"
      >
        <header>
          <div>
            <span className="eyebrow">发送失败</span>
            <h2 id="assign-folder-title">需要工作区</h2>
          </div>
          <button className="icon" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <p className="assign-folder-desc">
          任务「{taskName}」尚未关联工作区，Agent 无法访问本地文件。请选择一个文件夹后重新发送。
        </p>
        <footer className="task-modal-actions">
          <button onClick={onClose}>稍后再说</button>
          <button className="primary" onClick={onPickFolder}>
            <FolderSearch size={14} />
            选择文件夹
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface DeleteDialogProps {
  deleteTarget: DeleteTarget;
  onClose(): void;
  removeWorkspace(path: string): Promise<void>;
  removeTask(task: TaskRecord): Promise<void>;
}

export function DeleteDialog({
  deleteTarget,
  onClose,
  removeWorkspace,
  removeTask,
}: DeleteDialogProps) {
  return (
    <div
      className="modal-backdrop delete-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <header>
          <span className="delete-dialog-icon">
            <Trash2 size={17} />
          </span>
          <div>
            <span className="eyebrow">删除记录</span>
            <h2 id="delete-dialog-title">
              {deleteTarget.kind === "workspace"
                ? `删除"${deleteTarget.name}"下的全部对话？`
                : `删除对话"${deleteTarget.task.name}"？`}
            </h2>
          </div>
          <button className="icon" title="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="delete-dialog-body">
          <p>
            {deleteTarget.kind === "workspace"
              ? `将删除该工作区下的 ${deleteTarget.count} 条对话记录。`
              : "将删除这条对话的消息、工具活动和上下文记录。"}
          </p>
          <ul>
            <li>正在执行的相关任务会立即停止</li>
            <li>磁盘上的对应对话记录会被清理</li>
            <li>
              <strong>不会删除工作区或任何项目文件</strong>
            </li>
          </ul>
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button
            className="danger"
            autoFocus
            onClick={() => {
              onClose();
              if (deleteTarget.kind === "workspace")
                void removeWorkspace(deleteTarget.path);
              else void removeTask(deleteTarget.task);
            }}
          >
            <Trash2 size={13} />
            确认删除
          </button>
        </footer>
      </section>
    </div>
  );
}
