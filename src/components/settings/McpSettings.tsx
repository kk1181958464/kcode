import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type {
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
  McpServerTransport,
} from "../../types";
import { uid } from "../../models";
import { errorMessage } from "../../lib/format";

type Draft = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string;
  url: string;
  headers: string;
};

function draftFromServer(server?: McpServerConfig): Draft {
  const transport = server?.transport;
  const urlTransport = transport?.type === "http" || transport?.type === "sse";
  return {
    id: server?.id ?? uid(),
    name: server?.name ?? "",
    description: server?.description ?? "",
    enabled: server?.enabled ?? true,
    transport: transport?.type ?? "stdio",
    command: transport?.type === "stdio" ? transport.command : "",
    args: transport?.type === "stdio" ? (transport.args ?? []).join("\n") : "",
    url: urlTransport ? transport.url : "",
    headers: urlTransport
      ? JSON.stringify(transport.headers ?? {}, null, 2)
      : "{}",
  };
}

function transportFromDraft(draft: Draft): McpServerTransport {
  if (draft.transport === "http" || draft.transport === "sse") {
    let headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(draft.headers || "{}");
      if (parsed && typeof parsed === "object")
        headers = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, String(value)]),
        );
    } catch {
      throw new Error("HTTP 请求头必须是有效 JSON");
    }
    return { type: draft.transport, url: draft.url.trim(), headers };
  }
  return {
    type: "stdio",
    command: draft.command.trim(),
    args: draft.args
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function configFromDraft(
  draft: Draft,
  previous?: McpServerConfig,
): McpServerConfig {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    enabled: draft.enabled,
    transport: transportFromDraft(draft),
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export function McpSettings() {
  const api = window.kcode?.mcp;
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [importText, setImportText] = useState("");

  useEffect(() => {
    if (!api) return;
    void api
      .list()
      .then(setServers)
      .catch((reason) => setError(errorMessage(reason)));
  }, [api]);

  const editingServer = useMemo(
    () => servers.find((server) => server.id === draft?.id),
    [draft?.id, servers],
  );

  async function saveDraft() {
    if (!api || !draft) return;
    setBusy(true);
    setError("");
    try {
      const next = configFromDraft(draft, editingServer);
      if (!next.id || !next.name) throw new Error("请填写 MCP 名称和 ID");
      setServers(await api.save(next));
      setDraft(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeServer(id: string) {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      setServers(await api.remove(id));
      setStatuses((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function testServer(id: string) {
    if (!api) return;
    setStatuses((current) => ({
      ...current,
      [id]: { id, connected: false, tools: [], error: "连接中…" },
    }));
    try {
      const status = await api.test(id);
      setStatuses((current) => ({ ...current, [id]: status }));
    } catch (reason) {
      setStatuses((current) => ({
        ...current,
        [id]: { id, connected: false, tools: [], error: errorMessage(reason) },
      }));
    }
  }

  async function loadTools(id: string) {
    if (!api) return;
    try {
      const tools = await api.tools(id);
      setStatuses((current) => ({
        ...current,
        [id]: {
          ...(current[id] ?? { id, connected: true }),
          connected: true,
          tools,
        },
      }));
      setExpanded((current) => new Set(current).add(id));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function importServers() {
    if (!api || !importText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const parsed = JSON.parse(importText) as Record<string, any>;
      const raw =
        parsed.mcpServers && typeof parsed.mcpServers === "object"
          ? parsed.mcpServers
          : parsed;
      for (const [name, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        const transport: McpServerTransport = entry.url
          ? entry.type === "sse"
            ? {
                type: "sse",
                url: String(entry.url),
                headers:
                  (entry.headers as Record<string, string> | undefined) ?? {},
              }
            : {
                type: "http",
                url: String(entry.url),
                headers:
                  (entry.headers as Record<string, string> | undefined) ?? {},
              }
          : {
              type: "stdio",
              command: String(entry.command ?? ""),
              args: Array.isArray(entry.args) ? entry.args.map(String) : [],
              env: (entry.env as Record<string, string> | undefined) ?? {},
            };
        if (
          !transport.type ||
          (transport.type === "stdio" && !transport.command)
        )
          continue;
        const existing = servers.find((server) => server.id === name);
        setServers(
          await api.save({
            id: name,
            name,
            description:
              typeof entry.description === "string"
                ? entry.description
                : undefined,
            enabled: entry.disabled !== true,
            transport,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          }),
        );
      }
      setImportText("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!api)
    return <div className="settings-empty">当前运行环境不支持 MCP 管理。</div>;

  return (
    <section className="settings-section mcp-settings-section">
      <div className="settings-section-header with-action">
        <div>
          <h3>MCP 扩展</h3>
          <p>
            连接本机 stdio、HTTP 或 SSE MCP 服务，工具会在任务运行时按需调用。
          </p>
        </div>
        <button
          className="add-provider"
          onClick={() => setDraft(draftFromServer())}
        >
          <Plus size={16} /> 添加服务
        </button>
      </div>
      {error && (
        <div className="settings-inline-error">
          <CircleAlert size={14} /> {error}
          <button className="icon" title="关闭" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="mcp-server-list">
        {servers.length ? (
          servers.map((server) => {
            const status = statuses[server.id];
            const toolOpen = expanded.has(server.id);
            return (
              <article
                className={`mcp-server-card ${server.enabled ? "" : "disabled"}`}
                key={server.id}
              >
                <header>
                  <span className="mcp-server-mark">
                    <Plug size={16} />
                  </span>
                  <span className="mcp-server-copy">
                    <strong>{server.name}</strong>
                    <small>
                      {server.id} ·{" "}
                      {server.transport.type === "stdio"
                        ? server.transport.command
                        : server.transport.url}
                    </small>
                  </span>
                  <span
                    className={`mcp-status ${status?.connected ? "online" : status?.error ? "error" : ""}`}
                  >
                    <i />{" "}
                    {status?.connected
                      ? `${status.tools.length} 个工具`
                      : server.enabled
                        ? "未检测"
                        : "已停用"}
                  </span>
                  <button
                    className={`setting-switch ${server.enabled ? "on" : ""}`}
                    role="switch"
                    aria-checked={server.enabled}
                    title={server.enabled ? "停用服务" : "启用服务"}
                    onClick={() =>
                      void api.save({ ...server, enabled: !server.enabled })
                    }
                  >
                    <span />
                  </button>
                </header>
                {server.description && (
                  <p className="mcp-server-description">{server.description}</p>
                )}
                {status?.error && (
                  <div className="mcp-error">
                    <CircleAlert size={13} /> {status.error}
                  </div>
                )}
                <footer>
                  <button
                    className="secondary"
                    disabled={!server.enabled || busy}
                    onClick={() => void testServer(server.id)}
                  >
                    <RefreshCw size={13} /> 测试连接
                  </button>
                  <button
                    className="secondary"
                    disabled={!server.enabled || busy}
                    onClick={() => void loadTools(server.id)}
                  >
                    <ChevronDown size={13} /> 查看工具
                  </button>
                  <button
                    className="icon"
                    title="编辑"
                    onClick={() => setDraft(draftFromServer(server))}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className="icon danger"
                    title="删除"
                    onClick={() => void removeServer(server.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </footer>
                {toolOpen && status?.tools?.length ? (
                  <div className="mcp-tool-list">
                    {status.tools.map((tool: McpToolDescriptor) => (
                      <div key={tool.name}>
                        <code>{tool.name}</code>
                        <span>{tool.description || "无描述"}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })
        ) : (
          <div className="settings-empty">暂无 MCP 服务</div>
        )}
      </div>
      <div className="mcp-import">
        <label>
          <span>导入 mcpServers JSON</span>
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={
              '{"mcpServers":{"my-server":{"command":"npx","args":["-y","... "]}}}'
            }
          />
        </label>
        <button
          className="secondary"
          disabled={busy || !importText.trim()}
          onClick={() => void importServers()}
        >
          <Save size={13} /> 导入配置
        </button>
      </div>
      {draft && (
        <div
          className="mcp-editor-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setDraft(undefined)
          }
        >
          <div
            className="mcp-editor"
            role="dialog"
            aria-modal="true"
            aria-label="MCP 服务设置"
          >
            <header>
              <h4>{editingServer ? "编辑 MCP 服务" : "添加 MCP 服务"}</h4>
              <button
                className="icon"
                title="关闭"
                onClick={() => setDraft(undefined)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="form-grid">
              <label>
                名称
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Filesystem"
                />
              </label>
              <label>
                ID
                <input
                  value={draft.id}
                  disabled={Boolean(editingServer)}
                  onChange={(event) =>
                    setDraft({ ...draft, id: event.target.value })
                  }
                />
              </label>
              <label className="wide">
                描述
                <input
                  value={draft.description}
                  onChange={(event) =>
                    setDraft({ ...draft, description: event.target.value })
                  }
                />
              </label>
              <label>
                传输
                <select
                  value={draft.transport}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      transport: event.target.value as Draft["transport"],
                    })
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </label>
              {draft.transport === "stdio" ? (
                <>
                  <label>
                    命令
                    <input
                      value={draft.command}
                      onChange={(event) =>
                        setDraft({ ...draft, command: event.target.value })
                      }
                      placeholder="npx"
                    />
                  </label>
                  <label className="wide">
                    参数（每行一个）
                    <textarea
                      value={draft.args}
                      onChange={(event) =>
                        setDraft({ ...draft, args: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="wide">
                    URL
                    <input
                      value={draft.url}
                      onChange={(event) =>
                        setDraft({ ...draft, url: event.target.value })
                      }
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                  <label className="wide">
                    请求头 JSON
                    <textarea
                      value={draft.headers}
                      onChange={(event) =>
                        setDraft({ ...draft, headers: event.target.value })
                      }
                    />
                  </label>
                </>
              )}
            </div>
            <footer>
              <button
                className={`setting-switch ${draft.enabled ? "on" : ""}`}
                role="switch"
                aria-checked={draft.enabled}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              >
                <span /> 启用
              </button>
              <span />
              <button className="secondary" onClick={() => setDraft(undefined)}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void saveDraft()}
              >
                <Check size={14} /> 保存
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
