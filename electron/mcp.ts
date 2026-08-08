import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "../src/types";
import { writeLog } from "./logger";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

const MCP_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOOL_OUTPUT = 120_000;

let configured = new Map<string, McpServerConfig>();

function normalizedCommand(command: string) {
  if (process.platform !== "win32") return command;
  const lower = command.toLowerCase();
  if (["npx", "npm", "pnpm", "yarn", "bun"].includes(lower))
    return `${command}.cmd`;
  return command;
}

function validConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<McpServerConfig>;
  if (
    typeof item.id !== "string" ||
    !item.id.trim() ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    typeof item.enabled !== "boolean" ||
    !item.transport ||
    typeof item.transport !== "object"
  )
    return false;
  const transport = item.transport as Record<string, unknown>;
  if (transport.type === "stdio")
    return (
      typeof transport.command === "string" && Boolean(transport.command.trim())
    );
  if (transport.type === "http" || transport.type === "sse")
    return (
      typeof transport.url === "string" && /^https?:\/\//i.test(transport.url)
    );
  return false;
}

function normalizeConfig(value: McpServerConfig): McpServerConfig {
  const now = Date.now();
  const transport =
    value.transport.type === "stdio"
      ? {
          type: "stdio" as const,
          command: value.transport.command.trim(),
          args: (value.transport.args ?? []).map(String).slice(0, 64),
          env: Object.fromEntries(
            Object.entries(value.transport.env ?? {})
              .filter(
                ([key, item]) =>
                  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                  typeof item === "string",
              )
              .slice(0, 100),
          ),
        }
      : {
          type: value.transport.type,
          url: value.transport.url.trim(),
          headers: Object.fromEntries(
            Object.entries(value.transport.headers ?? {})
              .filter(([key, item]) => key.trim() && typeof item === "string")
              .slice(0, 50),
          ),
        };
  return {
    id: value.id.trim().slice(0, 128),
    name: value.name.trim().slice(0, 160),
    description: value.description?.trim().slice(0, 500) || undefined,
    enabled: value.enabled,
    transport,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now,
    updatedAt: now,
  };
}

class StdioSession {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private started = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text)
        writeLog("info", "mcp.stderr", {
          server: config.id,
          text: text.slice(-2_000),
        });
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.started = false;
      this.fail(
        new Error(
          `MCP 服务 ${config.name} 已退出（${code ?? signal ?? "未知"}）`,
        ),
      );
    });
  }

  private fail(error: unknown) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (
        headerEnd >= 0 &&
        /^content-length\s*:/im.test(
          this.buffer.subarray(0, headerEnd).toString("ascii"),
        )
      ) {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = /content-length\s*:\s*(\d+)/i.exec(header);
        if (!match) return;
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (this.buffer.length < start + length) return;
        const payload = this.buffer
          .subarray(start, start + length)
          .toString("utf8");
        this.buffer = this.buffer.subarray(start + length);
        this.handle(payload);
        continue;
      }
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.handle(line);
    }
  }

  private handle(raw: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (message.error)
      pending.reject(new Error(message.error.message || "MCP 请求失败"));
    else pending.resolve(message.result);
  }

  private send(message: JsonRpcMessage) {
    if (!this.child.stdin.writable)
      throw new Error(`MCP 服务 ${this.config.name} 的输入已关闭`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params?: unknown) {
    this.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let cleanup: () => void = () => undefined;
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.cleanup();
        item.reject(new Error(`MCP 服务 ${this.config.name} 响应超时`));
      }, REQUEST_TIMEOUT_MS);
      const abort = () => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.cleanup();
        item.reject(new Error("MCP 操作已取消"));
      };
      cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.send({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.cleanup();
        item.reject(error);
      }
    });
  }

  async initialize(signal?: AbortSignal) {
    if (this.started) return;
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "KCode", version: "0.2" },
      },
      signal,
    );
    this.notify("notifications/initialized");
    this.started = true;
  }

  close() {
    this.fail(new Error("MCP 会话已关闭"));
    if (!this.child.killed) this.child.kill();
  }
}

type SsePendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

class SseSession {
  private readonly pending = new Map<number, SsePendingRequest>();
  private readonly controller = new AbortController();
  private nextId = 1;
  private endpoint?: string;
  private endpointReady: Promise<void>;
  private resolveEndpoint!: () => void;
  private rejectEndpoint!: (reason?: unknown) => void;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private connecting?: Promise<void>;
  private initializing?: Promise<void>;
  private initialized = false;
  private buffer = "";
  private eventName = "message";
  private dataLines: string[] = [];

  constructor(private readonly config: McpServerConfig) {
    this.endpointReady = new Promise<void>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
  }

  private fail(error: unknown) {
    this.rejectEndpoint(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }

  private dispatchEvent() {
    const data = this.dataLines.join("\n").trim();
    const event = this.eventName;
    this.eventName = "message";
    this.dataLines = [];
    if (!data) return;
    if (event === "endpoint") {
      try {
        if (this.config.transport.type !== "sse") return;
        this.endpoint = new URL(data, this.config.transport.url).toString();
        this.resolveEndpoint();
      } catch (error) {
        this.fail(new Error(`MCP SSE endpoint 无效：${String(error)}`));
      }
      return;
    }
    try {
      this.handleMessage(JSON.parse(data) as JsonRpcMessage);
    } catch {
      writeLog("warn", "mcp.sse.invalid_message", {
        server: this.config.id,
        text: data.slice(0, 500),
      });
    }
  }

  private consume(chunk: string) {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) this.dispatchEvent();
      else if (line.startsWith("event:"))
        this.eventName = line.slice(6).trim() || "message";
      else if (line.startsWith("data:"))
        this.dataLines.push(line.slice(5).trimStart());
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id === undefined) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (message.error)
      pending.reject(new Error(message.error.message || "MCP SSE 请求失败"));
    else pending.resolve(message.result);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        this.consume(decoder.decode(next.value, { stream: true }));
      }
      this.consume(decoder.decode());
      this.dispatchEvent();
      this.fail(new Error(`MCP SSE 服务 ${this.config.name} 已断开`));
    } catch (error) {
      this.fail(error);
    }
  }

  private async open() {
    if (this.config.transport.type !== "sse")
      throw new Error("MCP 服务不是 SSE 类型");
    const response = await fetch(this.config.transport.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...(this.config.transport.headers ?? {}),
      },
      signal: this.controller.signal,
    });
    if (!response.ok)
      throw new Error(
        `MCP SSE HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    if (!response.body) throw new Error("MCP SSE 服务没有返回事件流");
    this.reader = response.body.getReader();
    void this.readLoop(this.reader);
    await this.endpointReady;
  }

  private async connect(signal?: AbortSignal) {
    if (this.endpoint) return;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = undefined;
      });
    }
    if (!signal) return this.connecting;
    if (signal.aborted) throw new Error("MCP 操作已取消");
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("MCP 操作已取消"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.connecting!.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }).catch((error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  async request(method: string, params?: unknown, signal?: AbortSignal) {
    await this.connect(signal);
    if (!this.endpoint) throw new Error("MCP SSE endpoint 尚未就绪");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let cleanup: () => void = () => undefined;
      const postController = new AbortController();
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.cleanup();
        item.reject(`MCP SSE 服务 ${this.config.name} 响应超时`);
      }, REQUEST_TIMEOUT_MS);
      const finishReject = (reason: unknown) => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        item.cleanup();
        item.reject(reason);
      };
      const abort = () => {
        postController.abort();
        finishReject(new Error("MCP 操作已取消"));
      };
      cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      void fetch(this.endpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.config.transport.type === "sse"
            ? (this.config.transport.headers ?? {})
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: postController.signal,
      })
        .then(async (response) => {
          const body = await response.text();
          if (!response.ok)
            throw new Error(
              `MCP SSE HTTP ${response.status}: ${body.slice(0, 500)}`,
            );
          if (body.trim()) {
            const message = parseHttpPayload(
              body,
              response.headers.get("content-type") || "",
            );
            if (message) this.handleMessage(message);
          }
        })
        .catch(finishReject);
    });
  }

  async notify(method: string, params?: unknown, signal?: AbortSignal) {
    await this.connect(signal);
    if (!this.endpoint) throw new Error("MCP SSE endpoint 尚未就绪");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.transport.type === "sse"
          ? (this.config.transport.headers ?? {})
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      }),
      signal,
    });
    if (!response.ok)
      throw new Error(
        `MCP SSE HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    await response.arrayBuffer();
  }

  async initialize(signal?: AbortSignal) {
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await this.request(
          "initialize",
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "KCode", version: "0.2" },
          },
          signal,
        );
        await this.notify("notifications/initialized", undefined, signal);
        this.initialized = true;
      })().finally(() => {
        this.initializing = undefined;
      });
    }
    await this.initializing;
  }

  close() {
    this.controller.abort();
    void this.reader?.cancel().catch(() => undefined);
    this.fail(new Error("MCP SSE 会话已关闭"));
  }
}

const sessions = new Map<string, StdioSession>();
const sseSessions = new Map<string, SseSession>();
const httpSessionIds = new Map<string, string>();
const initializedHttpServers = new Set<string>();
const httpInitializations = new Map<string, Promise<void>>();

export function configureMcpServers(items: unknown) {
  const next = new Map<string, McpServerConfig>();
  if (Array.isArray(items))
    for (const item of items)
      if (validConfig(item)) next.set(item.id, normalizeConfig(item));
  for (const session of sessions.values()) session.close();
  for (const session of sseSessions.values()) session.close();
  sessions.clear();
  sseSessions.clear();
  httpSessionIds.clear();
  initializedHttpServers.clear();
  httpInitializations.clear();
  configured = next;
}

export function listMcpServerConfigs() {
  return [...configured.values()];
}

export function saveMcpServerConfig(value: McpServerConfig) {
  if (!validConfig(value)) throw new Error("MCP 配置不完整");
  const next = normalizeConfig(value);
  sessions.get(next.id)?.close();
  sessions.delete(next.id);
  sseSessions.get(next.id)?.close();
  sseSessions.delete(next.id);
  httpSessionIds.delete(next.id);
  initializedHttpServers.delete(next.id);
  httpInitializations.delete(next.id);
  configured.set(next.id, next);
  return listMcpServerConfigs();
}

export function removeMcpServerConfig(id: string) {
  sessions.get(id)?.close();
  sessions.delete(id);
  sseSessions.get(id)?.close();
  sseSessions.delete(id);
  configured.delete(id);
  httpSessionIds.delete(id);
  initializedHttpServers.delete(id);
  httpInitializations.delete(id);
  return listMcpServerConfigs();
}

function getConfig(id: string) {
  const config = configured.get(id);
  if (!config) throw new Error(`MCP 服务不存在：${id}`);
  if (!config.enabled) throw new Error(`MCP 服务已停用：${config.name}`);
  return config;
}

async function stdioSession(config: McpServerConfig, signal?: AbortSignal) {
  let session = sessions.get(config.id);
  if (!session) {
    if (config.transport.type !== "stdio")
      throw new Error("MCP 服务不是 stdio 类型");
    const child = spawn(
      normalizedCommand(config.transport.command),
      config.transport.args ?? [],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...(config.transport.env ?? {}) },
        stdio: "pipe",
        windowsHide: true,
      },
    );
    session = new StdioSession(config, child);
    sessions.set(config.id, session);
  }
  try {
    await session.initialize(signal);
    return session;
  } catch (error) {
    session.close();
    sessions.delete(config.id);
    throw error;
  }
}

async function sseSession(config: McpServerConfig, signal?: AbortSignal) {
  let session = sseSessions.get(config.id);
  if (!session) {
    session = new SseSession(config);
    sseSessions.set(config.id, session);
  }
  try {
    await session.initialize(signal);
    return session;
  } catch (error) {
    session.close();
    sseSessions.delete(config.id);
    throw error;
  }
}

function parseHttpPayload(body: string, contentType: string) {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  if (/text\/event-stream/i.test(contentType)) {
    const messages = trimmed
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .filter(Boolean);
    const payload = messages.at(-1);
    return payload ? (JSON.parse(payload) as JsonRpcMessage) : undefined;
  }
  const parsed = JSON.parse(trimmed) as JsonRpcMessage | JsonRpcMessage[];
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

async function httpMessage(
  config: McpServerConfig,
  message: JsonRpcMessage,
  signal?: AbortSignal,
) {
  if (config.transport.type !== "http")
    throw new Error("MCP 服务不是 HTTP 类型");
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(config.transport.headers ?? {}),
  };
  const sessionId = httpSessionIds.get(config.id);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(config.transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal,
  });
  const returnedSession = response.headers.get("mcp-session-id");
  if (returnedSession) httpSessionIds.set(config.id, returnedSession);
  const body = await response.text();
  if (!response.ok)
    throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = parseHttpPayload(
    body,
    response.headers.get("content-type") || "",
  );
  if (!parsed) return undefined;
  if (parsed.error) throw new Error(parsed.error.message || "MCP 请求失败");
  return parsed.result;
}

function httpRequest(
  config: McpServerConfig,
  method: string,
  params: unknown,
  signal?: AbortSignal,
) {
  return httpMessage(
    config,
    {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 2_000_000_000),
      method,
      params,
    },
    signal,
  );
}

async function initializeHttpServer(
  config: McpServerConfig,
  signal?: AbortSignal,
) {
  if (initializedHttpServers.has(config.id)) return;
  const active = httpInitializations.get(config.id);
  if (active) return active;
  const initialization = (async () => {
    await httpRequest(
      config,
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "KCode", version: "0.2" },
      },
      signal,
    );
    await httpMessage(
      config,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      signal,
    );
    initializedHttpServers.add(config.id);
  })();
  httpInitializations.set(config.id, initialization);
  try {
    await initialization;
  } finally {
    httpInitializations.delete(config.id);
  }
}

async function requestMcp(
  config: McpServerConfig,
  method: string,
  params: unknown,
  signal?: AbortSignal,
) {
  if (config.transport.type === "stdio")
    return (await stdioSession(config, signal)).request(method, params, signal);
  if (config.transport.type === "sse")
    return (await sseSession(config, signal)).request(method, params, signal);
  await initializeHttpServer(config, signal);
  return httpRequest(config, method, params, signal);
}

function normalizeTools(value: any): McpToolDescriptor[] {
  const tools = Array.isArray(value?.tools) ? value.tools : [];
  return tools
    .filter((tool: any) => tool && typeof tool.name === "string")
    .slice(0, 500)
    .map((tool: any) => ({
      name: String(tool.name).slice(0, 200),
      description:
        typeof tool.description === "string"
          ? tool.description.slice(0, 2_000)
          : undefined,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : undefined,
    }));
}

export async function listMcpTools(id: string, signal?: AbortSignal) {
  const config = getConfig(id);
  const result = await requestMcp(config, "tools/list", {}, signal);
  return normalizeTools(result);
}

export async function testMcpServer(id: string): Promise<McpServerStatus> {
  const checkedAt = Date.now();
  try {
    const tools = await listMcpTools(id);
    return { id, connected: true, tools, checkedAt };
  } catch (error) {
    return {
      id,
      connected: false,
      tools: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function callMcpTool(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  const config = getConfig(id);
  if (!tool.trim()) throw new Error("缺少 MCP 工具名称");
  onProgress?.(`正在调用 ${config.name} · ${tool}`);
  const result = await requestMcp(
    config,
    "tools/call",
    { name: tool.trim(), arguments: args ?? {} },
    signal,
  );
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((item: any) =>
      item?.type === "text" ? String(item.text ?? "") : JSON.stringify(item),
    )
    .filter(Boolean)
    .join("\n");
  return {
    output: (text || JSON.stringify(result ?? {}, null, 2)).slice(
      0,
      MAX_TOOL_OUTPUT,
    ),
    isError: Boolean(result?.isError),
  };
}

export function closeMcpServers() {
  for (const session of sessions.values()) session.close();
  for (const session of sseSessions.values()) session.close();
  sessions.clear();
  sseSessions.clear();
  httpSessionIds.clear();
  initializedHttpServers.clear();
  httpInitializations.clear();
}

export function mcpServerIds() {
  return [...configured.values()]
    .filter((item) => item.enabled)
    .map((item) => item.id);
}
