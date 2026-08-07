import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Search,
  Server,
  Unplug,
  X,
} from "lucide-react";
import type {
  SshRemoteEntry,
  SshRemoteState,
  SshRemoteWorkspace,
} from "../../ssh-remote-types";
import { errorMessage } from "../../lib/format";

type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  loading?: boolean;
  error?: string;
};

type EditorSession = {
  workspaceId: string;
  rootPath: string;
  directories: Record<string, SshRemoteEntry[]>;
  expandedDirectories: Set<string>;
  tabs: EditorTab[];
  activePath?: string;
  query: string;
  explorerOpen: boolean;
};

const editorSessions = new Map<string, EditorSession>();

const editorTheme = [
  EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "#171b18", color: "#e4ebe6" },
      ".cm-content": {
        caretColor: "#8da2ff",
        fontFamily: "'Cascadia Code', Consolas, monospace",
        fontSize: "12.5px",
        lineHeight: "1.65",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#8da2ff" },
      ".cm-gutters": {
        backgroundColor: "#151815",
        color: "#667068",
        border: "0",
      },
      ".cm-activeLineGutter": { backgroundColor: "#202620" },
      ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.028)" },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(91,108,255,.34) !important",
      },
      ".cm-scroller": { overflow: "auto" },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: "#c9a7ff" },
      { tag: [tags.name, tags.deleted, tags.character], color: "#e4ebe6" },
      {
        tag: [tags.propertyName, tags.function(tags.variableName)],
        color: "#8fc7ff",
      },
      { tag: [tags.string, tags.special(tags.string)], color: "#a8d7a0" },
      { tag: [tags.number, tags.bool, tags.null], color: "#f3bd78" },
      { tag: [tags.comment, tags.meta], color: "#718078", fontStyle: "italic" },
      {
        tag: [tags.heading, tags.strong],
        color: "#d9e1ff",
        fontWeight: "bold",
      },
      { tag: tags.link, color: "#77c8c2", textDecoration: "underline" },
    ]),
  ),
];

function fileName(remotePath: string) {
  return remotePath.split("/").filter(Boolean).at(-1) || remotePath;
}

function joinRemotePath(rootPath: string, value: string) {
  return `${rootPath.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

async function languageFor(remotePath: string): Promise<Extension> {
  const extension = fileName(remotePath).split(".").at(-1)?.toLowerCase();
  if (["js", "jsx", "mjs", "cjs"].includes(extension || ""))
    return import("@codemirror/lang-javascript").then(({ javascript }) =>
      javascript({ jsx: extension === "jsx" }),
    );
  if (["ts", "tsx", "mts", "cts"].includes(extension || ""))
    return import("@codemirror/lang-javascript").then(({ javascript }) =>
      javascript({ typescript: true, jsx: extension === "tsx" }),
    );
  if (["html", "htm", "vue", "svelte", "xml"].includes(extension || ""))
    return import("@codemirror/lang-html").then(({ html }) => html());
  if (["css", "scss", "less"].includes(extension || ""))
    return import("@codemirror/lang-css").then(({ css }) => css());
  if (["json", "jsonc"].includes(extension || ""))
    return import("@codemirror/lang-json").then(({ json }) => json());
  if (["md", "mdx"].includes(extension || ""))
    return import("@codemirror/lang-markdown").then(({ markdown }) =>
      markdown(),
    );
  if (["py", "pyw"].includes(extension || ""))
    return import("@codemirror/lang-python").then(({ python }) => python());
  if (extension === "php")
    return import("@codemirror/lang-php").then(({ php }) => php());
  return [];
}

function formatSize(size: number) {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

export default function SshRemoteEditor({
  taskId,
  workspace,
  state,
  onStateChange,
  onReconnect,
}: {
  taskId: string;
  workspace: SshRemoteWorkspace;
  state?: SshRemoteState;
  onStateChange(state: SshRemoteState): void;
  onReconnect(): void;
}) {
  const restoredSession = useRef(
    editorSessions.get(taskId)?.workspaceId === workspace.id &&
      editorSessions.get(taskId)?.rootPath === workspace.rootPath
      ? editorSessions.get(taskId)
      : undefined,
  ).current;
  const [directories, setDirectories] = useState<
    Record<string, SshRemoteEntry[]>
  >(restoredSession?.directories ?? {});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => new Set(restoredSession?.expandedDirectories ?? [workspace.rootPath]),
  );
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [tabs, setTabs] = useState<EditorTab[]>(restoredSession?.tabs ?? []);
  const [activePath, setActivePath] = useState<string | undefined>(
    restoredSession?.activePath,
  );
  const [query, setQuery] = useState(restoredSession?.query ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(
    restoredSession?.explorerOpen ?? true,
  );
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [confirmClosePath, setConfirmClosePath] = useState<string>();
  const [languageExtension, setLanguageExtension] = useState<Extension>([]);
  const saveActiveRef = useRef<() => void>(() => undefined);

  const loadDirectory = useCallback(
    async (remotePath: string, force = false) => {
      if (!state?.connected || (directories[remotePath] && !force)) return;
      setLoadingDirectories((current) => new Set(current).add(remotePath));
      setError("");
      try {
        const entries = await window.kcode.sshRemote.list(
          taskId,
          workspace.id,
          remotePath,
        );
        setDirectories((current) => ({ ...current, [remotePath]: entries }));
        const latest = await window.kcode.sshRemote.state(taskId, workspace.id);
        onStateChange(latest);
      } catch (reason) {
        setError(errorMessage(reason));
        const latest = await window.kcode.sshRemote
          .state(taskId, workspace.id)
          .catch(() => undefined);
        if (latest) onStateChange(latest);
      } finally {
        setLoadingDirectories((current) => {
          const next = new Set(current);
          next.delete(remotePath);
          return next;
        });
      }
    },
    [directories, onStateChange, state?.connected, taskId, workspace.id],
  );

  useEffect(() => {
    editorSessions.set(taskId, {
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      directories,
      expandedDirectories,
      tabs,
      activePath,
      query,
      explorerOpen,
    });
    while (editorSessions.size > 20) {
      const oldestTaskId = editorSessions.keys().next().value;
      if (!oldestTaskId || oldestTaskId === taskId) break;
      editorSessions.delete(oldestTaskId);
    }
  }, [
    activePath,
    directories,
    expandedDirectories,
    explorerOpen,
    query,
    tabs,
    taskId,
    workspace.id,
    workspace.rootPath,
  ]);

  const hasDirtyTabs = tabs.some((tab) => tab.content !== tab.savedContent);
  useEffect(() => {
    if (!hasDirtyTabs) return;
    const confirmAppClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmAppClose);
    return () => window.removeEventListener("beforeunload", confirmAppClose);
  }, [hasDirtyTabs]);

  useEffect(() => {
    if (state?.connected) void loadDirectory(workspace.rootPath);
  }, [loadDirectory, state?.connected, workspace.rootPath]);

  const visibleEntries = useMemo(() => {
    const rows: Array<SshRemoteEntry & { depth: number }> = [];
    const visit = (directory: string, depth: number) => {
      for (const entry of directories[directory] ?? []) {
        rows.push({ ...entry, depth });
        if (entry.type === "directory" && expandedDirectories.has(entry.path))
          visit(entry.path, depth + 1);
      }
    };
    visit(workspace.rootPath, 0);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery
      ? rows.filter((entry) =>
          `${entry.name} ${entry.path}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
      : rows;
  }, [directories, expandedDirectories, query, workspace.rootPath]);

  const activeTab = tabs.find((tab) => tab.path === activePath);
  const activeDirty = Boolean(
    activeTab && activeTab.content !== activeTab.savedContent,
  );
  useEffect(() => {
    let active = true;
    setLanguageExtension([]);
    if (activeTab?.path)
      void languageFor(activeTab.path)
        .then((extension) => active && setLanguageExtension(extension))
        .catch(() => active && setLanguageExtension([]));
    return () => {
      active = false;
    };
  }, [activeTab?.path]);
  const activeExtensions = useMemo(
    () => [languageExtension, EditorView.lineWrapping],
    [languageExtension],
  );

  async function toggleDirectory(entry: SshRemoteEntry) {
    const expanded = expandedDirectories.has(entry.path);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (expanded) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!expanded) await loadDirectory(entry.path);
  }

  async function openFile(entry: Pick<SshRemoteEntry, "path">) {
    setActivePath(entry.path);
    if (tabs.some((tab) => tab.path === entry.path)) return;
    setTabs((current) => [
      ...current,
      { path: entry.path, content: "", savedContent: "", loading: true },
    ]);
    setError("");
    try {
      const file = await window.kcode.sshRemote.read(
        taskId,
        workspace.id,
        entry.path,
      );
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
    if (!activeTab || !activeDirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const file = await window.kcode.sshRemote.write(
        taskId,
        workspace.id,
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
  saveActiveRef.current = () => void saveActive();

  async function createFile() {
    const relative = newFileName.trim().replace(/^\/+/, "");
    if (!relative) return;
    const remotePath = joinRemotePath(workspace.rootPath, relative);
    setSaving(true);
    setError("");
    try {
      await window.kcode.sshRemote.write(
        taskId,
        workspace.id,
        remotePath,
        "",
        null,
      );
      setNewFileName("");
      setNewFileOpen(false);
      await loadDirectory(workspace.rootPath, true);
      await openFile({ path: remotePath });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  function closeTab(remotePath: string, force = false) {
    const tab = tabs.find((item) => item.path === remotePath);
    if (!force && tab && tab.content !== tab.savedContent) {
      setConfirmClosePath(remotePath);
      return;
    }
    const index = tabs.findIndex((item) => item.path === remotePath);
    const next = tabs.filter((item) => item.path !== remotePath);
    setTabs(next);
    if (activePath === remotePath)
      setActivePath(next[Math.max(0, index - 1)]?.path ?? next[0]?.path);
    setConfirmClosePath(undefined);
  }

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActiveRef.current();
      }
    };
    window.addEventListener("keydown", handleSave, true);
    return () => window.removeEventListener("keydown", handleSave, true);
  }, []);

  if (!state?.connected)
    return (
      <section className="ssh-editor ssh-editor-disconnected">
        <div>
          <span>
            <Unplug size={20} />
          </span>
          <strong>SSH Remote 未连接</strong>
          <small>
            {state?.error ||
              `${workspace.username}@${workspace.host}:${workspace.port}`}
          </small>
          <button type="button" onClick={onReconnect}>
            <Server size={14} />
            重新连接
          </button>
        </div>
      </section>
    );

  return (
    <section
      className={`ssh-editor ${explorerOpen ? "" : "explorer-collapsed"}`}
    >
      <aside className="ssh-explorer">
        <header>
          <span>
            <Server size={14} />
            <strong>{workspace.name}</strong>
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
              title="刷新远程目录"
              onClick={() => void loadDirectory(workspace.rootPath, true)}
            >
              <RefreshCw
                className={
                  loadingDirectories.has(workspace.rootPath) ? "spinning" : ""
                }
                size={14}
              />
            </button>
          </div>
        </header>
        <div className="ssh-explorer-root" title={workspace.rootPath}>
          {workspace.rootPath}
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
        <div className="ssh-file-tree" role="tree" aria-label="远程文件">
          {loadingDirectories.has(workspace.rootPath) &&
          !visibleEntries.length ? (
            <div className="ssh-tree-state">
              <LoaderCircle className="spinning" size={15} />
              读取目录
            </div>
          ) : visibleEntries.length ? (
            visibleEntries.map((entry) => {
              const directory = entry.type === "directory";
              const expanded = expandedDirectories.has(entry.path);
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={directory ? expanded : undefined}
                  className={`${activePath === entry.path ? "active" : ""} ${entry.type}`}
                  style={{ paddingLeft: `${8 + entry.depth * 14}px` }}
                  title={`${entry.path}${entry.type === "file" ? ` · ${formatSize(entry.size)}` : ""}`}
                  key={entry.path}
                  onClick={() =>
                    directory
                      ? void toggleDirectory(entry)
                      : entry.type === "file"
                        ? void openFile(entry)
                        : undefined
                  }
                >
                  <span className="ssh-tree-chevron">
                    {directory ? (
                      expanded ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )
                    ) : null}
                  </span>
                  {directory ? (
                    expanded ? (
                      <FolderOpen size={14} />
                    ) : (
                      <Folder size={14} />
                    )
                  ) : entry.type === "file" ? (
                    <FileCode2 size={14} />
                  ) : (
                    <FileText size={14} />
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
            {tabs.map((tab) => {
              const dirty = tab.content !== tab.savedContent;
              return (
                <button
                  type="button"
                  className={tab.path === activePath ? "active" : ""}
                  title={tab.path}
                  key={tab.path}
                  onClick={() => setActivePath(tab.path)}
                >
                  <FileCode2 size={13} />
                  <span>{fileName(tab.path)}</span>
                  {dirty && <i title="未保存" />}
                  <span
                    className="ssh-tab-close"
                    role="button"
                    aria-label={`关闭 ${fileName(tab.path)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.path);
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="ssh-save-file"
            title="保存远程文件"
            disabled={!activeDirty || saving}
            onClick={() => void saveActive()}
          >
            {saving ? (
              <LoaderCircle className="spinning" size={14} />
            ) : (
              <Save size={14} />
            )}
          </button>
        </header>

        <div className="ssh-editor-breadcrumb">
          {activeTab ? activeTab.path : workspace.rootPath}
        </div>
        <div className="ssh-editor-surface">
          {!activeTab ? (
            <div className="ssh-editor-empty">
              <FileCode2 size={25} />
              <strong>打开远程文件开始编辑</strong>
              <small>{workspace.rootPath}</small>
            </div>
          ) : activeTab.loading ? (
            <div className="ssh-editor-empty">
              <LoaderCircle className="spinning" size={20} />
              <strong>正在读取 {fileName(activeTab.path)}</strong>
            </div>
          ) : activeTab.error ? (
            <div className="ssh-editor-empty error">
              <FileText size={22} />
              <strong>无法打开文件</strong>
              <small>{activeTab.error}</small>
            </div>
          ) : (
            <CodeMirror
              value={activeTab.content}
              height="100%"
              theme={editorTheme}
              extensions={activeExtensions}
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
            <i /> SSH {workspace.username}@{workspace.host}
          </span>
          {activeTab && !activeTab.loading && !activeTab.error && (
            <>
              <span>{activeDirty ? "已修改" : "已保存"}</span>
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
            <p>{fileName(confirmClosePath)} 的修改将被丢弃。</p>
            <footer>
              <button
                type="button"
                onClick={() => setConfirmClosePath(undefined)}
              >
                取消
              </button>
              <button
                type="button"
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
