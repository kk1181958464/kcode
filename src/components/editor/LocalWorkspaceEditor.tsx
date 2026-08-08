import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import type { WorkspaceEntry } from "../../types";
import { errorMessage } from "../../lib/format";
import { editorTheme, formatSize, languageFor } from "./editor-support";

type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  loading?: boolean;
  error?: string;
};

type EditorSession = {
  root: string;
  directories: Record<string, WorkspaceEntry[]>;
  expanded: Set<string>;
  tabs: EditorTab[];
  activePath?: string;
  query: string;
  explorerOpen: boolean;
};

const sessions = new Map<string, EditorSession>();

function baseName(value: string) {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || value;
}

function joinPath(root: string, relative: string) {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.replace(/^[\\/]+/, "")}`;
}

export default function LocalWorkspaceEditor({
  taskId,
  root,
}: {
  taskId: string;
  root: string;
}) {
  const restored = useRef(
    sessions.get(taskId)?.root === root ? sessions.get(taskId) : undefined,
  ).current;
  const [directories, setDirectories] = useState<
    Record<string, WorkspaceEntry[]>
  >(restored?.directories ?? {});
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(restored?.expanded ?? [root]),
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<EditorTab[]>(restored?.tabs ?? []);
  const [activePath, setActivePath] = useState<string | undefined>(
    restored?.activePath,
  );
  const [query, setQuery] = useState(restored?.query ?? "");
  const [explorerOpen, setExplorerOpen] = useState(
    restored?.explorerOpen ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [confirmClosePath, setConfirmClosePath] = useState<string>();
  const [languageExtension, setLanguageExtension] = useState<Extension>([]);
  const saveRef = useRef<() => void>(() => undefined);

  const loadDirectory = useCallback(
    async (directory: string, force = false) => {
      if (directories[directory] && !force) return;
      setLoading((current) => new Set(current).add(directory));
      setError("");
      try {
        const entries = await window.kcode.workspace.list(root, directory);
        setDirectories((current) => ({ ...current, [directory]: entries }));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(directory);
          return next;
        });
      }
    },
    [directories, root],
  );

  useEffect(() => {
    void loadDirectory(root);
  }, [loadDirectory, root]);

  useEffect(() => {
    sessions.set(taskId, {
      root,
      directories,
      expanded,
      tabs,
      activePath,
      query,
      explorerOpen,
    });
    while (sessions.size > 20) {
      const first = sessions.keys().next().value;
      if (!first || first === taskId) break;
      sessions.delete(first);
    }
  }, [
    activePath,
    directories,
    expanded,
    explorerOpen,
    query,
    root,
    tabs,
    taskId,
  ]);

  const rows = useMemo(() => {
    const output: Array<WorkspaceEntry & { depth: number }> = [];
    const visit = (directory: string, depth: number) => {
      for (const entry of directories[directory] ?? []) {
        output.push({ ...entry, depth });
        if (entry.type === "directory" && expanded.has(entry.path))
          visit(entry.path, depth + 1);
      }
    };
    visit(root, 0);
    const normalized = query.trim().toLowerCase();
    return normalized
      ? output.filter((entry) =>
          `${entry.name} ${entry.path}`.toLowerCase().includes(normalized),
        )
      : output;
  }, [directories, expanded, query, root]);

  const activeTab = tabs.find((tab) => tab.path === activePath);
  const dirty = Boolean(
    activeTab && activeTab.content !== activeTab.savedContent,
  );
  const extensions = useMemo(
    () => [languageExtension, EditorView.lineWrapping],
    [languageExtension],
  );

  useEffect(() => {
    let active = true;
    setLanguageExtension([]);
    if (activeTab?.path)
      void languageFor(activeTab.path)
        .then((value) => active && setLanguageExtension(value))
        .catch(() => active && setLanguageExtension([]));
    return () => {
      active = false;
    };
  }, [activeTab?.path]);

  async function toggleDirectory(entry: WorkspaceEntry) {
    const open = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      open ? next.delete(entry.path) : next.add(entry.path);
      return next;
    });
    if (!open) await loadDirectory(entry.path);
  }

  async function openFile(entry: Pick<WorkspaceEntry, "path">) {
    setActivePath(entry.path);
    if (tabs.some((tab) => tab.path === entry.path)) return;
    setTabs((current) => [
      ...current,
      { path: entry.path, content: "", savedContent: "", loading: true },
    ]);
    setError("");
    try {
      const file = await window.kcode.workspace.read(root, entry.path);
      setTabs((current) =>
        current.map((tab) =>
          tab.path === entry.path
            ? {
                path: file.path,
                content: file.content,
                savedContent: file.content,
              }
            : tab,
        ),
      );
    } catch (reason) {
      const message = errorMessage(reason);
      setTabs((current) =>
        current.map((tab) =>
          tab.path === entry.path
            ? { ...tab, loading: false, error: message }
            : tab,
        ),
      );
      setError(message);
    }
  }

  async function saveActive() {
    if (!activeTab || !dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const file = await window.kcode.workspace.write(
        root,
        activeTab.path,
        activeTab.content,
        activeTab.savedContent,
      );
      setTabs((current) =>
        current.map((tab) =>
          tab.path === activeTab.path
            ? { ...tab, savedContent: file.content, error: undefined }
            : tab,
        ),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = () => void saveActive();

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", handleSave, true);
    return () => window.removeEventListener("keydown", handleSave, true);
  }, []);

  async function createFile() {
    const relative = newFileName.trim().replace(/^[\\/]+/, "");
    if (!relative) return;
    const target = joinPath(root, relative);
    setSaving(true);
    setError("");
    try {
      await window.kcode.workspace.write(root, target, "", null);
      setNewFileName("");
      setNewFileOpen(false);
      await loadDirectory(root, true);
      await openFile({ path: target });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  function closeTab(filePath: string, force = false) {
    const tab = tabs.find((item) => item.path === filePath);
    if (!force && tab && tab.content !== tab.savedContent) {
      setConfirmClosePath(filePath);
      return;
    }
    const index = tabs.findIndex((item) => item.path === filePath);
    const next = tabs.filter((item) => item.path !== filePath);
    setTabs(next);
    if (activePath === filePath)
      setActivePath(next[Math.max(0, index - 1)]?.path ?? next[0]?.path);
    setConfirmClosePath(undefined);
  }

  return (
    <section
      className={`ssh-editor local-workspace-editor ${explorerOpen ? "" : "explorer-collapsed"}`}
    >
      <aside className="ssh-explorer">
        <header>
          <span>
            <FolderOpen size={14} />
            <strong>{baseName(root)}</strong>
          </span>
          <div>
            <button
              type="button"
              title="新建文件"
              onClick={() => setNewFileOpen((value) => !value)}
            >
              <FilePlus2 size={14} />
            </button>
            <button
              type="button"
              title="刷新目录"
              onClick={() => void loadDirectory(root, true)}
            >
              <RefreshCw
                className={loading.has(root) ? "spinning" : ""}
                size={14}
              />
            </button>
          </div>
        </header>
        <div className="ssh-explorer-root" title={root}>
          {root}
        </div>
        <label className="ssh-explorer-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选文件"
          />
        </label>
        {newFileOpen && (
          <div className="ssh-new-file">
            <input
              value={newFileName}
              autoFocus
              placeholder="相对路径，如 src/app.ts"
              onChange={(event) => setNewFileName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createFile();
                if (event.key === "Escape") setNewFileOpen(false);
              }}
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void createFile()}
            >
              {saving ? (
                <LoaderCircle className="spinning" size={13} />
              ) : (
                <FilePlus2 size={13} />
              )}
            </button>
          </div>
        )}
        <div className="ssh-file-tree" role="tree" aria-label="本地文件">
          {loading.has(root) && !rows.length ? (
            <div className="ssh-tree-state">
              <LoaderCircle className="spinning" size={15} />
              读取目录
            </div>
          ) : rows.length ? (
            rows.map((entry) => {
              const directory = entry.type === "directory";
              const open = expanded.has(entry.path);
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={directory ? open : undefined}
                  className={`${activePath === entry.path ? "active" : ""} ${entry.type}`}
                  style={{ paddingLeft: `${8 + entry.depth * 14}px` }}
                  title={`${entry.path}${entry.type === "file" ? ` · ${formatSize(entry.size)}` : ""}`}
                  key={entry.path}
                  onClick={() =>
                    directory
                      ? void toggleDirectory(entry)
                      : void openFile(entry)
                  }
                >
                  <span className="ssh-tree-chevron">
                    {directory ? (
                      open ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )
                    ) : null}
                  </span>
                  {directory ? (
                    open ? (
                      <FolderOpen size={14} />
                    ) : (
                      <Folder size={14} />
                    )
                  ) : (
                    <FileCode2 size={14} />
                  )}
                  <span>{entry.name}</span>
                </button>
              );
            })
          ) : (
            <div className="ssh-tree-state">目录为空</div>
          )}
        </div>
      </aside>
      <div className="ssh-editor-workbench">
        <header className="ssh-editor-tabs">
          <button
            type="button"
            className="ssh-explorer-toggle"
            title={explorerOpen ? "收起文件树" : "展开文件树"}
            onClick={() => setExplorerOpen((value) => !value)}
          >
            {explorerOpen ? (
              <PanelLeftClose size={14} />
            ) : (
              <PanelLeftOpen size={14} />
            )}
          </button>
          <div>
            {tabs.map((tab) => (
              <button
                type="button"
                className={tab.path === activePath ? "active" : ""}
                title={tab.path}
                key={tab.path}
                onClick={() => setActivePath(tab.path)}
              >
                <FileCode2 size={13} />
                <span>{baseName(tab.path)}</span>
                {tab.content !== tab.savedContent && <i title="未保存" />}
                <span
                  className="ssh-tab-close"
                  role="button"
                  aria-label={`关闭 ${baseName(tab.path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.path);
                  }}
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ssh-save-file"
            title="保存文件"
            disabled={!dirty || saving}
            onClick={() => void saveActive()}
          >
            {saving ? (
              <LoaderCircle className="spinning" size={14} />
            ) : (
              <Save size={14} />
            )}
          </button>
        </header>
        <div className="ssh-editor-breadcrumb">{activeTab?.path ?? root}</div>
        <div className="ssh-editor-surface">
          {!activeTab ? (
            <div className="ssh-editor-empty">
              <FileCode2 size={25} />
              <strong>打开文件开始编辑</strong>
              <small>{root}</small>
            </div>
          ) : activeTab.loading ? (
            <div className="ssh-editor-empty">
              <LoaderCircle className="spinning" size={20} />
              <strong>正在读取 {baseName(activeTab.path)}</strong>
            </div>
          ) : activeTab.error ? (
            <div className="ssh-editor-empty error">
              <strong>无法打开文件</strong>
              <small>{activeTab.error}</small>
            </div>
          ) : (
            <CodeMirror
              value={activeTab.content}
              height="100%"
              theme={editorTheme}
              extensions={extensions}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                searchKeymap: true,
              }}
              onChange={(content) =>
                setTabs((current) =>
                  current.map((tab) =>
                    tab.path === activeTab.path ? { ...tab, content } : tab,
                  ),
                )
              }
            />
          )}
        </div>
        <footer className="ssh-editor-status">
          <span className="connected">
            <i /> 本地工作区
          </span>
          {activeTab && !activeTab.loading && !activeTab.error && (
            <>
              <span>{dirty ? "已修改" : "已保存"}</span>
              <span>
                {activeTab.content.split("\n").length.toLocaleString()} 行
              </span>
              <span>UTF-8</span>
            </>
          )}
        </footer>
      </div>
      {error && (
        <div className="ssh-editor-error" role="alert">
          <span>{error}</span>
          <button type="button" title="关闭错误" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {confirmClosePath && (
        <div className="ssh-editor-confirm-layer">
          <div role="alertdialog" aria-modal="true" aria-label="放弃未保存修改">
            <strong>文件尚未保存</strong>
            <p>{baseName(confirmClosePath)} 的修改将被丢弃。</p>
            <footer>
              <button onClick={() => setConfirmClosePath(undefined)}>
                取消
              </button>
              <button
                className="danger"
                onClick={() => closeTab(confirmClosePath, true)}
              >
                放弃修改
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
