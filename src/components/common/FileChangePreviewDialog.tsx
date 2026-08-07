import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  FileCode2,
  FolderOpen,
  GitCompareArrows,
  TextWrap,
  X,
} from "lucide-react";
import { copyWithToast } from "../../lib/toast";
import { revealLocalPath } from "../../lib/reveal-path";
import { DiffView } from "./DiffView";

export type FileChangePreviewItem = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  revealable?: boolean;
};

function fileName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
}

export function FileChangePreviewDialog({
  files,
  selectedPath,
  workspacePath,
  onSelectPath,
  onClose,
}: {
  files: FileChangePreviewItem[];
  selectedPath: string;
  workspacePath: string;
  onSelectPath(path: string): void;
  onClose(): void;
}) {
  const [wrapLines, setWrapLines] = useState(true);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!selected || typeof document === "undefined") return null;
  const lineCount = selected.diff ? selected.diff.split("\n").length : 0;
  return createPortal(
    <div
      className="file-change-preview-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="file-change-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="查看本轮文件改动"
      >
        <header>
          <span>
            <GitCompareArrows size={16} />
            <span>
              <strong>本轮文件改动</strong>
              <small>
                {files.length} 个文件 · +{totals.additions} -{totals.deletions}
              </small>
            </span>
          </span>
          <div className="file-change-preview-actions">
            <button
              type="button"
              className={wrapLines ? "is-active" : ""}
              title={wrapLines ? "关闭长行自动换行" : "开启长行自动换行"}
              aria-label={wrapLines ? "关闭长行自动换行" : "开启长行自动换行"}
              aria-pressed={wrapLines}
              onClick={() => setWrapLines((value) => !value)}
            >
              <TextWrap size={15} />
            </button>
            <button
              type="button"
              title="复制当前文件差异"
              aria-label="复制当前文件差异"
              disabled={!selected.diff}
              onClick={() => void copyWithToast(selected.diff)}
            >
              <Copy size={14} />
            </button>
            {selected.revealable && (
              <button
                type="button"
                title="在文件资源管理器中显示"
                aria-label={`在文件资源管理器中显示 ${selected.path}`}
                onClick={() =>
                  void revealLocalPath(selected.path, workspacePath)
                }
              >
                <FolderOpen size={14} />
              </button>
            )}
            <button
              type="button"
              title="关闭"
              aria-label="关闭文件改动"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="file-change-preview-body">
          <nav aria-label="本轮变更文件">
            {files.map((file) => (
              <button
                type="button"
                key={file.path}
                className={file.path === selected.path ? "is-active" : ""}
                title={file.path}
                onClick={() => onSelectPath(file.path)}
              >
                <FileCode2 size={13} />
                <span>
                  <strong>{fileName(file.path)}</strong>
                  <small>{file.path}</small>
                </span>
                <em>
                  <b>+{file.additions}</b>
                  <i>-{file.deletions}</i>
                </em>
              </button>
            ))}
          </nav>
          <div className="file-change-preview-content">
            <div className="file-change-preview-meta">
              <code title={selected.path}>{selected.path}</code>
              <small>
                {lineCount
                  ? `${lineCount.toLocaleString()} 行差异`
                  : "无文本差异"}
              </small>
            </div>
            {selected.diff ? (
              <DiffView text={selected.diff} wrapLines={wrapLines} virtualize />
            ) : (
              <div className="file-change-preview-empty">
                该文件已发生变更，但没有可显示的文本差异。
              </div>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
