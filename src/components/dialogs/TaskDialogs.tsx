import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  FolderOpen,
  FolderSearch,
  LoaderCircle,
  PencilLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { TaskRecord } from "../../models";

interface PendingFolder {
  name: string;
  path: string;
}

type DeleteTarget =
  | { kind: "workspace"; workspaceKey: string; name: string; count: number }
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
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current)
        onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await createTask();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="new-task-dialog-layer"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !submitting && onClose()
      }
    >
      <section
        className="new-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <header>
          <span className="new-task-dialog-icon" aria-hidden="true">
            <Plus size={17} />
          </span>
          <h2 id="new-task-title">新建任务</h2>
          <button
            type="button"
            className="icon"
            onClick={onClose}
            title="关闭"
            aria-label="关闭新建任务"
            disabled={submitting}
          >
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submitTask(event)}>
          <div className="new-task-dialog-body">
            <label className="new-task-name-label" htmlFor={inputId}>
              <span>任务名称</span>
              <small>{newTaskName.length}/80</small>
            </label>
            <input
              ref={inputRef}
              id={inputId}
              className="new-task-name-input"
              value={newTaskName}
              onChange={(event) => setNewTaskName(event.target.value)}
              placeholder={pendingFolder?.name ?? "新任务"}
              maxLength={80}
              disabled={submitting}
            />
            <span className="new-task-workspace-label">工作区</span>
            <button
              type="button"
              className="new-task-workspace-picker"
              onClick={onPickFolder}
              disabled={submitting}
            >
              {pendingFolder ? (
                <FolderOpen size={17} />
              ) : (
                <FolderSearch size={17} />
              )}
              <span>
                <strong>
                  {pendingFolder?.name ?? "选择工作区文件夹"}
                </strong>
                <small>{pendingFolder?.path ?? "未关联工作区"}</small>
              </span>
              <span className="new-task-workspace-action">
                {pendingFolder ? "更换" : "选择"}
              </span>
            </button>
          </div>
          <footer>
            <button type="button" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Plus size={14} />
              )}
              {submitting ? "创建中" : "创建任务"}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export interface RenameTaskDialogProps {
  taskId: string;
  taskName: string;
  renameTask(taskId: string, name: string): Promise<void>;
  onClose(): void;
}

export function RenameTaskDialog({
  taskId,
  taskName,
  renameTask,
  onClose,
}: RenameTaskDialogProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(false);
  const [name, setName] = useState(taskName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const normalizedName = name.replace(/\s+/g, " ").trim();
  const unchanged = normalizedName === taskName;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current)
        onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current || !normalizedName || unchanged) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await renameTask(taskId, normalizedName);
      onClose();
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : "任务重命名失败，请重试",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="new-task-dialog-layer"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !submitting && onClose()
      }
    >
      <section
        className="new-task-dialog rename-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-task-title"
      >
        <header>
          <span className="new-task-dialog-icon" aria-hidden="true">
            <PencilLine size={17} />
          </span>
          <h2 id="rename-task-title">重命名任务</h2>
          <button
            type="button"
            className="icon"
            onClick={onClose}
            title="关闭"
            aria-label="关闭重命名任务"
            disabled={submitting}
          >
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submitRename(event)}>
          <div className="new-task-dialog-body">
            <label className="new-task-name-label" htmlFor={inputId}>
              <span>任务名称</span>
              <small>{name.length}/80</small>
            </label>
            <input
              ref={inputRef}
              id={inputId}
              className="new-task-name-input"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              maxLength={80}
              aria-invalid={Boolean(error)}
              disabled={submitting}
            />
            {error && (
              <p className="rename-task-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button type="button" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button
              className="primary"
              type="submit"
              disabled={submitting || !normalizedName || unchanged}
            >
              {submitting ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Check size={14} />
              )}
              {submitting ? "保存中" : "保存"}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
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
  removeWorkspace(workspaceKey: string): Promise<void>;
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
                void removeWorkspace(deleteTarget.workspaceKey);
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
