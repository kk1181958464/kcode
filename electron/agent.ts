import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  isLikelyNetworkCommand,
  runSpawnedCommand,
  terminateChildProcess,
} from "./process-command";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch, diffLines } from "diff";
import {
  inferReasoningConfig,
  type AgentActivity,
  type AgentEvent,
  type AgentToolName,
  type ModelRequest,
  type Protocol,
  type ReasoningEffort,
} from "../src/types";
import { isCasualGreeting } from "../src/intent";
import { resolvePermissionDecision } from "../src/permissions";
import { AgentStreamAssembler } from "./agent-stream";
import {
  createConversationIsolation,
  historyFingerprint,
} from "./conversation-isolation";
import { writeLog } from "./logger";
import { networkFetch } from "./network";
import { resolveGitExecutable } from "./executables";
import { conciseFailureOutput } from "./activity-errors";
import { powershellCommand } from "./powershell-command";
import {
  fetchWithRetry,
  isRetryableStreamError,
  readResponseText,
  readStreamChunk,
} from "./request-guard";
import {
  effectiveOpenAiProtocol,
  rememberChatFallback,
  shouldFallbackResponses,
} from "./protocol-fallback";
import {
  claimedGitOperations,
  requestedGitOperations,
  successfulGitEvidence,
} from "./git-operation-verification";
import {
  claimedCodingOperations,
  requestedCodingOperations,
  shouldRequireCodingTool,
  successfulCodingEvidence,
} from "./coding-operation-verification";
import { getProviderWithKey } from "./store";
import {
  bindBrowserRequest,
  browserIsOpen,
  cleanupBrowsers,
  clickBrowser,
  openBrowser,
  screenshotBrowser,
  snapshotBrowser,
  startBrowserRecording,
  stopBrowserRecording,
  typeBrowser,
} from "./browser";
import {
  adoptSshSession,
  cleanupSshSessions,
  connectSsh,
  disconnectSsh,
  downloadSshFile,
  listSshDirectory,
  readSshFile,
  runSshCommand,
  undoSshActivity,
  uploadSshFile,
  writeSshFile,
} from "./ssh";
import {
  adoptMysqlSession,
  cleanupMysqlSessions,
  connectMysql,
  disconnectMysql,
  queryMysql,
  type MysqlConnectInput,
} from "./mysql";
import {
  adoptSqlServerSession,
  cleanupSqlServerSessions,
  connectSqlServer,
  disconnectSqlServer,
  querySqlServer,
  type SqlServerConnectInput,
} from "./sqlserver";
import {
  adoptMongoSession,
  cleanupMongoSessions,
  connectMongo,
  disconnectMongo,
  executeMongo,
  type MongoConnectInput,
} from "./mongodb";
import {
  classifyMysqlSql,
  classifySqlServerSql,
} from "./sql-policy";
import {
  resolveProjectDiagnostic,
  type DiagnosticKind,
} from "./project-diagnostics";
import {
  bundledRipgrepPath,
  nativeGlobFiles,
  nativeSearchCode,
} from "./workspace-search";
import {
  beginSubagentCleanup,
  claimSubagentMutation,
  closeSubagentMessageQueue,
  drainSubagentMessages,
  listSubagents,
  messageSubagent,
  permissionPolicyForSubagent,
  spawnSubagent,
  stopSubagent,
  waitForSubagents,
} from "./subagents";

type ToolCall = {
  id: string;
  name: AgentToolName;
  input: Record<string, unknown>;
};
type ToolResult = Partial<
  Pick<
    AgentActivity,
    | "path"
    | "command"
    | "diff"
    | "additions"
    | "deletions"
    | "fileChanges"
    | "exitCode"
    | "undoable"
    | "childActivities"
  >
> & {
  output: string;
  subagentUsage?: { input: number; output: number; cached: number };
};

async function* streamOperationProgress<T>(
  operation: (report: (output: string) => void) => Promise<T>,
): AsyncGenerator<string, T> {
  let latestOutput: string | undefined;
  let wake: (() => void) | undefined;
  let done = false;
  let result: T | undefined;
  let failure: unknown;
  const report = (output: string) => {
    latestOutput = output;
    wake?.();
    wake = undefined;
  };
  void operation(report)
    .then((value) => {
      result = value;
      done = true;
      wake?.();
    })
    .catch((error) => {
      failure = error;
      done = true;
      wake?.();
    });
  while (!done || latestOutput !== undefined) {
    if (latestOutput === undefined)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    if (latestOutput !== undefined) {
      const output = latestOutput;
      latestOutput = undefined;
      yield output;
    }
  }
  if (failure) throw failure;
  return result as T;
}
type StructuredToolResult = {
  success: boolean;
  summary: string;
  data: Record<string, unknown>;
  truncated: boolean;
  error?: { message: string; exitCode?: number };
};
type Turn = {
  text: string;
  calls: ToolCall[];
  rawCalls: unknown[];
  usage: { input: number; output: number; cached: number };
};
type HistoryItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      content: string;
      images?: ModelRequest["messages"][number]["images"];
    }
  | { kind: "calls"; calls: ToolCall[]; rawCalls: unknown[] }
  | { kind: "result"; callId: string; content: string };

function compactRuntimeHistory(history: HistoryItem[], force = false) {
  if (history.length <= 8 && !force) return false;
  const firstMessage = history.find(
    (item): item is Extract<HistoryItem, { kind: "message" }> =>
      item.kind === "message",
  );
  const recent = history.slice(-8).map((item): HistoryItem => {
    if (!force || item.kind !== "result") return item;
    try {
      const result = JSON.parse(item.content) as StructuredToolResult;
      return {
        ...item,
        content: JSON.stringify({
          ...result,
          data: {
            path: result.data?.path,
            command: result.data?.command,
            diff:
              typeof result.data?.diff === "string"
                ? result.data.diff.slice(0, 2_000)
                : undefined,
          },
          truncated: true,
        }),
      };
    } catch {
      return { ...item, content: item.content.slice(0, 2_000) };
    }
  });
  const older = history.slice(0, -8);
  const facts: string[] = [];
  // Connections opened earlier stay usable for the whole task, so their
  // coordinates are durable facts that must survive compaction verbatim instead
  // of being dropped with the rest of the call history. Keep the full input
  // (host/port/user and, unlike the UI summary, the credentials the model may
  // need to reconnect within this run) — runtime history is never shown to the
  // user or persisted, so it is the safe place to retain them.
  const connections: string[] = [];
  for (const item of older) {
    if (item.kind === "calls")
      for (const call of item.calls)
        if (
          [
            "ssh_connect",
            "mysql_connect",
            "mysql_connect_via_ssh",
            "sqlserver_connect",
            "sqlserver_connect_via_ssh",
            "mongodb_connect",
            "mongodb_connect_via_ssh",
          ].includes(call.name)
        )
          connections.push(`${call.name} ${JSON.stringify(call.input)}`);
    if (item.kind === "message" && item !== firstMessage)
      facts.push(
        `${item.role}: ${item.content.replace(/\s+/g, " ").slice(0, 500)}`,
      );
    if (item.kind === "result") {
      try {
        const result = JSON.parse(item.content) as StructuredToolResult;
        if (
          !result.success ||
          result.data?.diff ||
          result.data?.path ||
          /测试|构建|验证|失败/.test(result.summary)
        )
          facts.push(
            `${result.summary}: ${JSON.stringify({ path: result.data?.path, diff: typeof result.data?.diff === "string" ? result.data.diff.slice(0, 1_000) : undefined, error: result.error })}`,
          );
      } catch {
        /* Ignore legacy unstructured results. */
      }
    }
  }
  const uniqueConnections = [...new Set(connections)];
  const connectionBlock = uniqueConnections.length
    ? `已建立的连接（会话在本次运行内仍然可用，如需重连可复用以下凭据，不要向用户重复索取）：\n${uniqueConnections.join("\n")}\n\n`
    : "";
  const summary: HistoryItem = {
    kind: "message",
    role: "user",
    content: `<runtime_compaction>较早的 Agent 工具循环已压缩。${connectionBlock}关键状态：\n${facts.slice(-80).join("\n")}</runtime_compaction>`,
  };
  history.splice(
    0,
    history.length,
    ...(firstMessage ? [firstMessage] : []),
    summary,
    ...recent.filter((item) => item !== firstMessage),
  );
  return true;
}

const trim = (value: string) => value.replace(/\/+$/, "");
const apiEndpoint = (baseUrl: string, resource: string) => {
  const base = trim(baseUrl);
  return `${base}${/\/v1$/i.test(base) ? "" : "/v1"}/${resource}`;
};
const base64Data = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);
const decodeHtml = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
const stripHtml = (value: string) =>
  decodeHtml(
    value
      .replace(
        /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
const privateAddress = (address: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(address) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address);
async function validatePublicUrl(input: string) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("只允许公开 HTTP/HTTPS URL");
  if (
    ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())
  )
    throw new Error("禁止访问本机或内网地址");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => privateAddress(item.address))
  )
    throw new Error("禁止访问本机、内网或保留地址");
  return url;
}
async function fetchPublic(
  input: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
) {
  let url = await validatePublicUrl(input);
  let timedOut = false;
  const controller = new AbortController(),
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await networkFetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 KCode/1.0",
          Accept:
            "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        url = await validatePublicUrl(
          new URL(response.headers.get("location")!, url).href,
        );
        continue;
      }
      if (!response.ok) throw new Error(`网页请求失败 (${response.status})`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 2 * 1024 * 1024) throw new Error("网页响应超过 2 MB");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 2 * 1024 * 1024)
        throw new Error("网页响应超过 2 MB");
      return {
        url: url.href,
        contentType: response.headers.get("content-type") || "",
        text: new TextDecoder("utf-8").decode(bytes),
      };
    }
    throw new Error("网页重定向次数过多");
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal.aborted) throw new Error("任务已取消");
      if (timedOut)
        throw new Error(`网页读取超时（${Math.round(timeoutMs / 1_000)} 秒）`);
    }
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const details =
      cause && typeof cause === "object"
        ? (cause as { code?: string; message?: string })
        : undefined;
    const code = details?.code;
    const message = details?.message || (error instanceof Error ? error.message : String(error));
    if (/fetch failed/i.test(message)) {
      const reason = code ? `${code}: ` : "";
      throw new Error(`网页连接失败（${reason}${message}）URL: ${url.href}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
const tools = [
  {
    name: "list_directory",
    description:
      "List files and directories in a workspace directory. Use this instead of shell dir/Get-ChildItem.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "glob_files",
    description: "Find workspace files using a glob such as **/*.ts.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "read_many_files",
    description: "Read up to 20 UTF-8 workspace files in one call.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "path_info",
    description: "Get type, size, and timestamps for a workspace path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: "Search text in workspace files.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, glob: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a Begin Patch text patch for precise file edits. Never invoke apply_patch through run_command; call this tool directly. Supports Update File, Add File, and Delete File sections.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 file in the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "make_directory",
    description: "Create a directory and missing parents in the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "move_path",
    description: "Move or rename a file or directory inside the workspace.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or directory inside the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Show concise Git working tree status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "git_diff",
    description: "Show Git diff for the workspace or one path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, staged: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "git_log",
    description: "Show recent Git commits.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "git_show",
    description: "Show a Git revision or file at a revision.",
    parameters: {
      type: "object",
      properties: { revision: { type: "string" }, path: { type: "string" } },
      required: ["revision"],
      additionalProperties: false,
    },
  },
  {
    name: "start_process",
    description:
      "Start a long-running PowerShell process such as a dev server and return a process id.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "process_output",
    description: "Read buffered output and status for a background process.",
    parameters: {
      type: "object",
      properties: { processId: { type: "string" } },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_process",
    description: "Stop a background process started by start_process.",
    parameters: {
      type: "object",
      properties: { processId: { type: "string" } },
      required: ["processId"],
      additionalProperties: false,
    },
  },
  {
    name: "diagnostics",
    description:
      "Run a common project validation command (typecheck, test, lint, or build).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["typecheck", "test", "lint", "build"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the public internet. Returns structured titles, URLs, and snippets. Use this for current facts and finding documentation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 10 },
        domain: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch and extract readable text from a public HTTP or HTTPS URL. Use after web_search to inspect a source.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "number", minimum: 1000, maximum: 50000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_open",
    description:
      "Open a visible isolated browser window at an HTTP/HTTPS URL for interactive or authenticated tasks.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Return page text and references for visible interactive elements in the current browser.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: "Click an element reference from the latest browser snapshot.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an element from the latest browser snapshot, including credentials explicitly provided by the user.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture the current browser page to a local PNG.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_record_start",
    description:
      "Start an optional browser recording for this task. Call only when the user explicitly asks to record. Captures subsequent page operations, network requests, headers, bodies, responses, and tokens.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_record_stop",
    description:
      "Stop the active browser recording and export the captured session as JSON plus a Python Playwright script.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ssh_connect",
    description:
      "Connect this task to an SSH server using credentials explicitly supplied by the user. The privateKey value must be the key content, not a local path. Host keys are not verified. The connection remains available while switching tasks.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        passphrase: { type: "string" },
      },
      required: ["host", "username"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_run",
    description:
      "Run a command on the SSH server connected to this task. Defaults to a 180 second timeout and stops when the task is cancelled. Set pty and stdin only for commands that require controlled interactive input.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        stdin: { type: "string" },
        pty: { type: "boolean" },
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 600_000,
          description: "Optional timeout in milliseconds. Defaults to 180000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_list_directory",
    description:
      "List a directory on the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_read_file",
    description:
      "Read a UTF-8 text file from the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_write_file",
    description:
      "Create or replace a UTF-8 text file on the SSH server connected to this task using SFTP.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_upload_file",
    description:
      "Upload a local file to the SSH server connected to this task using SFTP. localPath is an absolute path on this machine; remotePath is the destination on the server. Handles binary files.",
    parameters: {
      type: "object",
      properties: {
        localPath: { type: "string" },
        remotePath: { type: "string" },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_download_file",
    description:
      "Download a file from the SSH server connected to this task to this machine using SFTP. remotePath is the source on the server; localPath is an absolute destination path on this machine. Handles binary files.",
    parameters: {
      type: "object",
      properties: {
        remotePath: { type: "string" },
        localPath: { type: "string" },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_disconnect",
    description: "Disconnect the SSH session associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mysql_connect",
    description:
      "Connect this task directly to a MySQL server using credentials explicitly supplied by the user. Public direct hosts use verified TLS by default; private and localhost addresses do not. Never disable TLS after a failure unless the user explicitly approves the downgrade. The connection remains available while switching tasks.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        ssl: { type: "boolean" },
        sslCa: { type: "string" },
        sslCert: { type: "string" },
        sslKey: { type: "string" },
        sslPassphrase: { type: "string" },
        sslRejectUnauthorized: { type: "boolean" },
      },
      required: ["host", "username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "mysql_connect_via_ssh",
    description:
      "Connect to MySQL through this task's SSH tunnel. If SSH credentials are supplied, establish SSH first; otherwise reuse the task's active SSH connection. The MySQL host is resolved from the SSH server and commonly defaults to 127.0.0.1.",
    parameters: {
      type: "object",
      properties: {
        sshHost: { type: "string" },
        sshPort: { type: "number", minimum: 1, maximum: 65535 },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        ssl: { type: "boolean" },
        sslCa: { type: "string" },
        sslCert: { type: "string" },
        sslKey: { type: "string" },
        sslPassphrase: { type: "string" },
        sslRejectUnauthorized: { type: "boolean" },
      },
      required: ["host", "username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "mysql_query",
    description:
      "Execute one SQL statement on the MySQL connection for this task. Supports positional ? placeholders through the values array. Multiple statements are disabled.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        values: { type: "array" },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "mysql_disconnect",
    description: "Close the MySQL connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sqlserver_connect",
    description:
      "Connect this task directly to Microsoft SQL Server. Public hosts use encryption with certificate verification by default; only trust a self-signed certificate when the user explicitly approves it.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        encrypt: { type: "boolean" },
        trustServerCertificate: { type: "boolean" },
      },
      required: ["host", "username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_connect_via_ssh",
    description:
      "Connect to Microsoft SQL Server through this task's SSH tunnel, establishing SSH from supplied credentials or reusing the active SSH connection.",
    parameters: {
      type: "object",
      properties: {
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        encrypt: { type: "boolean" },
        trustServerCertificate: { type: "boolean" },
      },
      required: ["host", "username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_query",
    description:
      "Execute one parameterized T-SQL statement. Use @p1, @p2, etc. placeholders corresponding to the values array. Multiple statements are not permitted.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" }, values: { type: "array" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_disconnect",
    description: "Close the SQL Server connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mongodb_connect",
    description:
      "Connect this task directly to MongoDB using a URI or host credentials. Public direct hosts use TLS by default. Credentials are shown in activity details.",
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        authSource: { type: "string" },
        tls: { type: "boolean" },
        tlsCA: { type: "string" },
        tlsCertificateKeyFile: { type: "string" },
      },
      required: ["database"],
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_connect_via_ssh",
    description:
      "Connect to MongoDB through this task's SSH tunnel, establishing SSH from supplied credentials or reusing the active SSH connection.",
    parameters: {
      type: "object",
      properties: {
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUsername: { type: "string" },
        sshPassword: { type: "string" },
        sshPrivateKey: { type: "string" },
        sshPassphrase: { type: "string" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        authSource: { type: "string" },
        tls: { type: "boolean" },
      },
      required: ["host", "database"],
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_execute",
    description:
      "Execute a structured MongoDB operation: find, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, countDocuments, or distinct. Arbitrary JavaScript is not supported.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "find",
            "aggregate",
            "insertOne",
            "insertMany",
            "updateOne",
            "updateMany",
            "deleteOne",
            "deleteMany",
            "countDocuments",
            "distinct",
          ],
        },
        collection: { type: "string" },
        filter: { type: "object" },
        document: { type: "object" },
        documents: { type: "array" },
        update: { type: "object" },
        pipeline: { type: "array" },
        field: { type: "string" },
        options: { type: "object" },
      },
      required: ["operation", "collection"],
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_disconnect",
    description: "Close the MongoDB connection associated with this task.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spawn_agent",
    description:
      "Start a background subagent for a self-contained task that can run independently. Subagents inherit the current model, workspace, reasoning, and permissions. Prefer separate files or research areas to avoid edit conflicts. Returns an agent id immediately.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        name: { type: "string" },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    description:
      "List direct subagents created by this agent and their current status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "message_agent",
    description:
      "Send an additional instruction to a running direct subagent. It will be applied before that subagent's next model turn.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        message: { type: "string" },
      },
      required: ["agentId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_agent",
    description:
      "Wait for selected direct subagents, or all direct subagents when agentIds is omitted. Returns their final text, tool summaries, usage, and file changes.",
    parameters: {
      type: "object",
      properties: {
        agentIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stop_agent",
    description:
      "Stop a running direct subagent and return its partial result.",
    parameters: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "Run a PowerShell command in the workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 600_000,
          description: "Optional timeout in milliseconds. Defaults to 120000.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as const;
const toolNames = new Set<AgentToolName>(tools.map((tool) => tool.name));
function validCalls(calls: ToolCall[]) {
  for (const call of calls)
    if (!toolNames.has(call.name))
      throw new Error(`模型请求了不支持的工具：${call.name}`);
  return calls;
}

const approvals = new Map<string, (allowed: boolean) => void>();
const undoSnapshots = new Map<
  string,
  {
    root: string;
    requestId: string;
    file: string;
    before: string;
    after: string;
    existed: boolean;
  }
>();
const backgroundProcesses = new Map<
  string,
  {
    root: string;
    requestId: string;
    child: ReturnType<typeof spawn>;
    output: string;
    exitCode?: number;
  }
>();
export async function cleanupAgentRecords(
  requestIds: string[],
  activityIds: string[],
) {
  const subagentCleanup = beginSubagentCleanup(requestIds);
  const childRequestIds = subagentCleanup.requestIds;
  const requests = new Set([...requestIds, ...childRequestIds]),
    activities = new Set(activityIds);
  for (const [activityId, snapshot] of undoSnapshots)
    if (activities.has(activityId) || requests.has(snapshot.requestId))
      undoSnapshots.delete(activityId);
  for (const [key, resolve] of approvals) {
    if ([...requests].some((requestId) => key.startsWith(`${requestId}:`))) {
      resolve(false);
      approvals.delete(key);
    }
  }
  for (const [id, process] of backgroundProcesses) {
    if (requests.has(process.requestId)) {
      terminateChildProcess(process.child);
      backgroundProcesses.delete(id);
    }
  }
  const allRequestIds = [...requests];
  cleanupBrowsers(allRequestIds);
  cleanupMysqlSessions(allRequestIds);
  cleanupSqlServerSessions(allRequestIds);
  cleanupMongoSessions(allRequestIds);
  cleanupSshSessions(allRequestIds, activityIds);
  await subagentCleanup.settle();
}
export function resolveApproval(
  requestId: string,
  activityId: string,
  allowed: boolean,
) {
  const exactKey = `${requestId}:${activityId}`;
  const exact = approvals.get(exactKey);
  if (exact) {
    exact(allowed);
    approvals.delete(exactKey);
    return;
  }
  for (const [key, resolve] of approvals)
    if (key.endsWith(`:${activityId}`)) {
      resolve(allowed);
      approvals.delete(key);
      return;
    }
}

export async function undoActivity(
  workspaceRoot: string,
  activityId: string,
  force = false,
) {
  const snapshot = undoSnapshots.get(activityId);
  if (!snapshot) {
    const remoteResult = await undoSshActivity(activityId, force);
    if (remoteResult) return remoteResult;
  }
  if (!snapshot || path.resolve(workspaceRoot) !== snapshot.root)
    return { success: false, message: "撤销记录已失效或不属于当前工作区" };
  let current = "";
  try {
    current = await readFile(snapshot.file, "utf8");
  } catch {
    return { success: false, message: "文件已被删除，无法安全撤销" };
  }
  if (current !== snapshot.after && !force)
    return {
      success: false,
      conflict: true,
      message: "文件在这个版本之后又被修改过",
    };
  if (snapshot.existed) await writeFile(snapshot.file, snapshot.before, "utf8");
  else await unlink(snapshot.file);
  undoSnapshots.delete(activityId);
  return {
    success: true,
    message: snapshot.existed ? "已恢复修改前内容" : "已删除本次新建的文件",
  };
}

function workspacePath(root: string, relative: unknown) {
  if (typeof relative !== "string" || !relative.trim())
    throw new Error("缺少文件路径");
  // Relative paths resolve against the workspace root; absolute paths (including
  // other drives) are honored as-is so the agent can reach files outside the
  // current workspace when the user asks for them.
  return path.resolve(root, relative);
}

let ripgrepDir: string | undefined;
function commandEnv(): NodeJS.ProcessEnv {
  if (ripgrepDir === undefined) {
    const rg = bundledRipgrepPath();
    ripgrepDir = rg === "rg" ? "" : path.dirname(rg);
  }
  if (!ripgrepDir) return process.env;
  const key =
    Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ??
    "PATH";
  const current = process.env[key] ?? "";
  return {
    ...process.env,
    [key]: current ? `${ripgrepDir}${path.delimiter}${current}` : ripgrepDir,
  };
}

function command(
  root: string,
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30_000,
  onOutput?: (output: string) => void,
  idleTimeoutMs?: number,
) {
  return runSpawnedCommand({
    executable,
    args,
    cwd: root,
    env: commandEnv(),
    signal,
    timeoutMs: timeout,
    idleTimeoutMs,
    onOutput,
  }).then(({ output, exitCode }) => ({ output, exitCode }));
}

function failureSummary(call: ToolCall, output: string, exitCode?: number) {
  if (
    call.name.startsWith("mysql_") ||
    call.name.startsWith("sqlserver_") ||
    call.name.startsWith("mongodb_")
  )
    return output;
  if (call.name.startsWith("ssh_")) {
    if (call.name === "ssh_run" && exitCode !== undefined) {
      const detail = conciseFailureOutput(output);
      return `远程命令执行失败，退出码 ${exitCode}${detail ? `：${detail}` : "。"}`;
    }
    return output;
  }
  if (call.name.startsWith("git_")) {
    const detail = conciseFailureOutput(output);
    return detail ? `Git 操作失败：${detail}` : "Git 操作失败。";
  }
  if (
    (call.name === "fetch_url" || call.name === "web_search") &&
    /网页读取超时|任务已取消|网页请求失败/.test(output)
  )
    return output;
  if (call.name === "run_command") {
    const script = String(call.input.command || "");
    if (/\*\*\* Begin Patch|\bapply_patch\b/i.test(script))
      return "补丁内容被当作 PowerShell 命令执行。请直接使用“应用补丁”工具。";
    if (
      /not recognized|CommandNotFoundException|找不到|无法将.*识别为/i.test(
        output,
      )
    )
      return "命令或程序不存在，请检查名称以及是否已安装。";
    const detail = conciseFailureOutput(output);
    return `命令执行失败，退出码 ${exitCode ?? "未知"}${detail ? `：${detail}` : "。"}`;
  }
  return `${({ apply_patch: "补丁应用", write_file: "文件写入", delete_path: "路径删除", move_path: "路径移动", make_directory: "目录创建", read_file: "文件读取", search_code: "代码搜索", list_directory: "目录读取", path_info: "路径检查" } as Partial<Record<AgentToolName, string>>)[call.name] || "工具执行"}失败。`;
}

// A non-zero exit code is not always an error. Many CLI tools return non-zero to
// report an ordinary outcome: ripgrep exits 1 when a search has no matches, git
// exits 128 outside a repository, linters exit 1 when they find problems. These
// commands ran to completion; only genuine failures (missing program, timeout,
// cancellation, misused patch) should surface as errors.
function isHardFailure(call: ToolCall, output: string) {
  if (call.name !== "run_command") return true;
  const script = String(call.input.command || "");
  if (/\*\*\* Begin Patch|\bapply_patch\b/i.test(script)) return true;
  if (/命令执行超时|命令已取消|没有新输出，已判定卡住/.test(output)) return true;
  if (
    /not recognized|CommandNotFoundException|找不到|无法将.*识别为/i.test(
      output,
    )
  )
    return true;
  return false;
}

function mysqlConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): MysqlConnectInput {
  return {
    host: String(input.host || defaultHost),
    port: Number(input.port) || 3306,
    username: String(input.username || ""),
    password: String(input.password || ""),
    database: typeof input.database === "string" ? input.database : undefined,
    ssl: typeof input.ssl === "boolean" ? input.ssl : undefined,
    sslCa: typeof input.sslCa === "string" ? input.sslCa : undefined,
    sslCert: typeof input.sslCert === "string" ? input.sslCert : undefined,
    sslKey: typeof input.sslKey === "string" ? input.sslKey : undefined,
    sslPassphrase:
      typeof input.sslPassphrase === "string" ? input.sslPassphrase : undefined,
    sslRejectUnauthorized:
      typeof input.sslRejectUnauthorized === "boolean"
        ? input.sslRejectUnauthorized
        : undefined,
  };
}

function sqlServerConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): SqlServerConnectInput {
  return {
    host: String(input.host || defaultHost),
    port: Number(input.port) || 1433,
    username: String(input.username || ""),
    password: String(input.password || ""),
    database: typeof input.database === "string" ? input.database : undefined,
    encrypt: typeof input.encrypt === "boolean" ? input.encrypt : undefined,
    trustServerCertificate:
      typeof input.trustServerCertificate === "boolean"
        ? input.trustServerCertificate
        : undefined,
  };
}

function mongoConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): MongoConnectInput {
  return {
    uri: typeof input.uri === "string" ? input.uri : undefined,
    host: String(input.host || defaultHost),
    port: Number(input.port) || 27017,
    username: typeof input.username === "string" ? input.username : undefined,
    password: typeof input.password === "string" ? input.password : undefined,
    database: String(input.database || ""),
    authSource:
      typeof input.authSource === "string" ? input.authSource : undefined,
    tls: typeof input.tls === "boolean" ? input.tls : undefined,
    tlsCA: typeof input.tlsCA === "string" ? input.tlsCA : undefined,
    tlsCertificateKeyFile:
      typeof input.tlsCertificateKeyFile === "string"
        ? input.tlsCertificateKeyFile
        : undefined,
  };
}

function diffFor(file: string, before: string, after: string) {
  if (before === after) return { diff: "", additions: 0, deletions: 0 };
  let additions = 0,
    deletions = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split("\n").length - 1;
    if (part.added) additions += count;
    if (part.removed) deletions += count;
  }
  return {
    diff: createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, "", "", {
      context: 3,
    }),
    additions,
    deletions,
  };
}

function applyUpdatePatch(original: string, lines: string[]) {
  const source = original.split("\n");
  let cursor = 0;
  const output: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) continue;
    const marker = line[0],
      value = line.slice(1);
    if (marker === " ") {
      const index = source.indexOf(value, cursor);
      if (index < 0) throw new Error(`补丁上下文不匹配：${value}`);
      output.push(...source.slice(cursor, index + 1));
      cursor = index + 1;
    } else if (marker === "-") {
      const index = source.indexOf(value, cursor);
      if (index < 0) throw new Error(`补丁删除内容不匹配：${value}`);
      output.push(...source.slice(cursor, index));
      cursor = index + 1;
    } else if (marker === "+") output.push(value);
    else if (line) throw new Error(`无法识别的补丁行：${line}`);
  }
  output.push(...source.slice(cursor));
  return output.join("\n");
}

async function applyPatch(
  root: string,
  requestId: string,
  activityId: string,
  patchText: string,
): Promise<ToolResult> {
  const lines = patchText.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch")
    throw new Error("补丁必须以 *** Begin Patch 开始");
  const changes: {
    file: string;
    before: string;
    after: string;
    existed: boolean;
  }[] = [];
  for (let index = 1; index < lines.length;) {
    const header = lines[index++];
    if (header === "*** End Patch") break;
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(header);
    if (!match) {
      if (!header.trim()) continue;
      throw new Error(`无法识别的补丁段：${header}`);
    }
    const [, action, relative] = match;
    const file = workspacePath(root, relative);
    const body: string[] = [];
    while (index < lines.length && !lines[index].startsWith("*** "))
      body.push(lines[index++]);
    let before = "",
      existed = true;
    try {
      before = await readFile(file, "utf8");
    } catch {
      existed = false;
    }
    if (action !== "Add" && !existed)
      throw new Error(`文件不存在：${relative}`);
    const after =
      action === "Delete"
        ? ""
        : action === "Add"
          ? body
              .filter((line) => line.startsWith("+"))
              .map((line) => line.slice(1))
              .join("\n")
          : applyUpdatePatch(before, body);
    changes.push({ file, before, after, existed });
  }
  if (!changes.length) throw new Error("补丁中没有文件变更");
  for (const change of changes) {
    if (!change.after && change.existed) await unlink(change.file);
    else {
      await mkdir(path.dirname(change.file), { recursive: true });
      await writeFile(change.file, change.after, "utf8");
    }
  }
  if (changes.length === 1 && changes[0].after) {
    const change = changes[0];
    undoSnapshots.set(activityId, { root, requestId, ...change });
  }
  const diffs = changes.map((change) => ({
    path: path.relative(root, change.file).replaceAll("\\", "/"),
    ...diffFor(
      path.relative(root, change.file).replaceAll("\\", "/"),
      change.before,
      change.after,
    ),
  }));
  return {
    output: `已应用补丁，修改 ${changes.length} 个文件`,
    path:
      changes.length === 1
        ? path.relative(root, changes[0].file)
        : `${changes.length} 个文件`,
    diff: diffs.map((item) => item.diff).join("\n\n"),
    additions: diffs.reduce((sum, item) => sum + item.additions, 0),
    deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
    fileChanges: diffs,
    undoable: changes.length === 1 && Boolean(changes[0].after),
  };
}

function mutationPaths(call: ToolCall) {
  if (call.name === "apply_patch")
    return [
      ...String(call.input.patch || "").matchAll(
        /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm,
      ),
    ].map((match) => match[1]);
  if (call.name === "move_path")
    return [String(call.input.from || ""), String(call.input.to || "")].filter(
      Boolean,
    );
  if (
    call.name === "write_file" ||
    call.name === "make_directory" ||
    call.name === "delete_path"
  )
    return [String(call.input.path || "")].filter(Boolean);
  return [];
}

async function execute(
  root: string,
  requestId: string,
  browserSessionId: string,
  activityId: string,
  call: ToolCall,
  request: ModelRequest,
  signal: AbortSignal,
  onProgress: (output: string) => void = () => undefined,
): Promise<ToolResult> {
  if (call.name === "list_directory") {
    const directory = workspacePath(root, call.input.path);
    const recursive = Boolean(call.input.recursive);
    const lines: string[] = [];
    const pending = [directory];
    const ignored = new Set([
      ".git",
      "node_modules",
      "dist",
      "dist-electron",
      "release",
      "build",
      ".next",
      ".cache",
    ]);
    while (pending.length && lines.length < 1_000) {
      if (signal.aborted) throw new Error("任务已取消");
      const current = pending.shift()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const relative = path.relative(directory, fullPath);
        lines.push(`${entry.isDirectory() ? "[dir] " : "[file]"} ${relative}`);
        if (lines.length >= 1_000) break;
        if (recursive && entry.isDirectory() && !ignored.has(entry.name))
          pending.push(fullPath);
      }
      if (!recursive) break;
    }
    return {
      path: path.relative(root, directory) || ".",
      output: lines.join("\n") || "目录为空",
    };
  }
  if (call.name === "glob_files") {
    const base = workspacePath(
      root,
      typeof call.input.path === "string" ? call.input.path : ".",
    );
    const pattern = String(call.input.pattern || "");
    if (!pattern) throw new Error("缺少 glob 模式");
    let output = "";
    try {
      const result = await command(
        base,
        bundledRipgrepPath(),
        [
          "--files",
          "--hidden",
          "--glob",
          "!.git",
          "--glob",
          "!node_modules",
          "--glob",
          pattern,
        ],
        signal,
        15_000,
      );
      if (result.exitCode > 1)
        throw new Error(result.output || `文件查找失败 (${result.exitCode})`);
      output = result.output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      output = await nativeGlobFiles(base, pattern, signal);
    }
    return {
      path: path.relative(root, base) || ".",
      output: output || "未找到匹配文件",
    };
  }
  if (call.name === "read_many_files") {
    const paths = Array.isArray(call.input.paths)
      ? call.input.paths.slice(0, 20)
      : [];
    if (!paths.length) throw new Error("缺少文件路径列表");
    const sections = await Promise.all(
      paths.map(async (item) => {
        const file = workspacePath(root, item);
        const content = await readFile(file, "utf8");
        return `===== ${path.relative(root, file)} =====\n${content.slice(0, 40_000)}`;
      }),
    );
    return { output: sections.join("\n\n").slice(0, 120_000) };
  }
  if (call.name === "path_info") {
    const target = workspacePath(root, call.input.path);
    const info = await stat(target);
    return {
      path: path.relative(root, target),
      output: JSON.stringify(
        {
          type: info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : "other",
          size: info.size,
          createdAt: info.birthtime.toISOString(),
          modifiedAt: info.mtime.toISOString(),
        },
        null,
        2,
      ),
    };
  }
  if (call.name === "read_file") {
    const file = workspacePath(root, call.input.path);
    const content = await readFile(file, "utf8");
    const start = Math.max(1, Number(call.input.startLine) || 1),
      end = Math.min(
        content.split("\n").length,
        Number(call.input.endLine) || start + 399,
      );
    return {
      output: content
        .split("\n")
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n")
        .slice(0, 80_000),
      path: path.relative(root, file),
    };
  }
  if (call.name === "search_code") {
    const query = String(call.input.query || "");
    if (!query) throw new Error("缺少搜索内容");
    const args = [
      "-n",
      "--hidden",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
      "--max-count",
      "200",
    ];
    if (call.input.glob) args.push("--glob", String(call.input.glob));
    args.push("--", query, ".");
    let output = "";
    try {
      const result = await command(
        root,
        bundledRipgrepPath(),
        args,
        signal,
        15_000,
      );
      if (result.exitCode > 1)
        throw new Error(result.output || `搜索失败 (${result.exitCode})`);
      output = result.output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      output = await nativeSearchCode(
        root,
        query,
        typeof call.input.glob === "string" ? call.input.glob : undefined,
        signal,
      );
    }
    return { output: output || "未找到匹配项" };
  }
  if (call.name === "write_file") {
    const file = workspacePath(root, call.input.path),
      content = String(call.input.content ?? "");
    let before = "",
      existed = true;
    try {
      before = await readFile(file, "utf8");
    } catch {
      existed = false;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    undoSnapshots.set(activityId, {
      root,
      requestId,
      file,
      before,
      after: content,
      existed,
    });
    return {
      output: `已写入 ${Buffer.byteLength(content)} 字节`,
      path: path.relative(root, file),
      undoable: true,
      ...diffFor(
        path.relative(root, file).replaceAll("\\", "/"),
        before,
        content,
      ),
    };
  }
  if (call.name === "apply_patch")
    return applyPatch(
      root,
      requestId,
      activityId,
      String(call.input.patch || ""),
    );
  if (call.name === "make_directory") {
    const directory = workspacePath(root, call.input.path);
    await mkdir(directory, { recursive: true });
    return { path: path.relative(root, directory), output: "目录已创建" };
  }
  if (call.name === "move_path") {
    const from = workspacePath(root, call.input.from),
      to = workspacePath(root, call.input.to);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    return {
      path: path.relative(root, to),
      output: `已从 ${path.relative(root, from)} 移动到 ${path.relative(root, to)}`,
    };
  }
  if (call.name === "delete_path") {
    const target = workspacePath(root, call.input.path);
    const info = await stat(target);
    await rm(target, {
      recursive: info.isDirectory() && Boolean(call.input.recursive),
      force: false,
    });
    return {
      path: path.relative(root, target),
      output: info.isDirectory() ? "目录已删除" : "文件已删除",
    };
  }
  if (call.name === "git_status") {
    const result = await command(
      root,
      resolveGitExecutable(),
      ["status", "--short", "--branch"],
      signal,
      15_000,
    );
    if (result.exitCode) throw new Error(result.output || "Git 状态读取失败");
    return { output: result.output || "工作区无变更" };
  }
  if (call.name === "git_diff") {
    const args = ["diff", "--no-ext-diff"];
    if (call.input.staged) args.push("--cached");
    if (call.input.path) args.push("--", String(call.input.path));
    const result = await command(
      root,
      resolveGitExecutable(),
      args,
      signal,
      20_000,
    );
    if (result.exitCode) throw new Error(result.output || "Git diff 读取失败");
    return { output: result.output || "没有差异" };
  }
  if (call.name === "git_log") {
    const limit = Math.min(50, Math.max(1, Number(call.input.limit) || 10));
    const result = await command(
      root,
      resolveGitExecutable(),
      ["log", `-${limit}`, "--date=short", "--pretty=format:%h %ad %s (%an)"],
      signal,
      15_000,
    );
    if (result.exitCode) throw new Error(result.output || "Git 日志读取失败");
    return { output: result.output || "没有提交记录" };
  }
  if (call.name === "git_show") {
    const revision = String(call.input.revision || "");
    if (!revision || !/^[\w./~^:-]+$/.test(revision))
      throw new Error("Git revision 格式无效");
    const spec = call.input.path
      ? `${revision}:${String(call.input.path).replaceAll("\\", "/")}`
      : revision;
    const result = await command(
      root,
      resolveGitExecutable(),
      ["show", "--no-ext-diff", "--format=fuller", spec],
      signal,
      20_000,
    );
    if (result.exitCode) throw new Error(result.output || "Git 内容读取失败");
    return { output: result.output };
  }
  if (call.name === "start_process") {
    const script = String(call.input.command || "");
    if (!script) throw new Error("缺少进程命令");
    const id = randomUUID();
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", powershellCommand(script)],
      { cwd: root, windowsHide: true, shell: false },
    );
    const process = { root, requestId, child, output: "" } as {
      root: string;
      requestId: string;
      child: ReturnType<typeof spawn>;
      output: string;
      exitCode?: number;
    };
    const append = (chunk: Buffer) => {
      process.output = (
        process.output + new TextDecoder("utf-8").decode(chunk)
      ).slice(-100_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      process.exitCode = code ?? -1;
    });
    backgroundProcesses.set(id, process);
    return { command: script, output: `后台进程已启动\nprocessId: ${id}` };
  }
  if (call.name === "process_output") {
    const id = String(call.input.processId || ""),
      process = backgroundProcesses.get(id);
    if (!process || process.root !== root)
      throw new Error("后台进程不存在或不属于当前工作区");
    return {
      output: `${process.exitCode === undefined ? "状态: 运行中" : `状态: 已退出 (${process.exitCode})`}\n${process.output || "暂无输出"}`,
      exitCode: process.exitCode === undefined ? undefined : process.exitCode,
    };
  }
  if (call.name === "stop_process") {
    const id = String(call.input.processId || ""),
      process = backgroundProcesses.get(id);
    if (!process || process.root !== root)
      throw new Error("后台进程不存在或不属于当前工作区");
    terminateChildProcess(process.child);
    backgroundProcesses.delete(id);
    return { output: `后台进程 ${id} 已停止` };
  }
  if (call.name === "web_search") {
    const query = String(call.input.query || "").trim();
    if (!query) throw new Error("缺少搜索关键词");
    const limit = Math.min(10, Math.max(1, Number(call.input.limit) || 5));
    const domain = String(call.input.domain || "").trim();
    const searchQuery = domain
      ? `${query} site:${domain.replace(/^https?:\/\//, "").split("/")[0]}`
      : query;
    let results: { title: string; url: string; snippet: string }[] = [];
    try {
      const page = await fetchPublic(
        `https://www.bing.com/search?format=rss&q=${encodeURIComponent(searchQuery)}`,
        signal,
      );
      results = [
        ...page.text.matchAll(
          /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi,
        ),
      ]
        .slice(0, limit)
        .map((match) => ({
          title: stripHtml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")),
          url: decodeHtml(match[2].trim()),
          snippet: stripHtml(match[3].replace(/^<!\[CDATA\[|\]\]>$/g, "")),
        }));
    } catch {
      const page = await fetchPublic(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
        signal,
      );
      results = [
        ...page.text.matchAll(
          /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ]
        .slice(0, limit)
        .map((match) => {
          const raw = decodeHtml(match[1]);
          const redirected = /uddg=([^&]+)/.exec(raw);
          const url = redirected ? decodeURIComponent(redirected[1]) : raw;
          return {
            title: stripHtml(match[2]),
            url,
            snippet: stripHtml(match[3]),
          };
        });
    }
    if (!results.length) throw new Error("搜索服务未返回结果");
    return { output: JSON.stringify({ query, results }, null, 2) };
  }
  if (call.name === "fetch_url") {
    const input = String(call.input.url || "").trim();
    if (!input) throw new Error("缺少网页 URL");
    const maxChars = Math.min(
      50_000,
      Math.max(1_000, Number(call.input.maxChars) || 20_000),
    );
    const page = await fetchPublic(input, signal);
    if (!/text|html|xml|json/i.test(page.contentType))
      throw new Error(`不支持读取 ${page.contentType || "未知"} 类型`);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text)?.[1];
    const content = /html/i.test(page.contentType)
      ? stripHtml(page.text)
      : page.text.trim();
    return {
      output: JSON.stringify(
        {
          url: page.url,
          title: title ? stripHtml(title) : undefined,
          content: content.slice(0, maxChars),
          truncated: content.length > maxChars,
        },
        null,
        2,
      ),
    };
  }
  if (call.name === "browser_open") {
    const result = await openBrowser(
      browserSessionId,
      String(call.input.url || ""),
      requestId,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "browser_snapshot")
    return {
      output: JSON.stringify(await snapshotBrowser(browserSessionId), null, 2),
    };
  if (call.name === "browser_click")
    return {
      output: JSON.stringify(
        await clickBrowser(browserSessionId, String(call.input.ref || "")),
        null,
        2,
      ),
    };
  if (call.name === "browser_type")
    return {
      output: JSON.stringify(
        await typeBrowser(
          browserSessionId,
          String(call.input.ref || ""),
          String(call.input.text ?? ""),
        ),
        null,
        2,
      ),
    };
  if (call.name === "browser_screenshot") {
    const result = await screenshotBrowser(browserSessionId);
    return { output: JSON.stringify(result, null, 2), path: result.path };
  }
  if (call.name === "browser_record_start")
    return {
      output: JSON.stringify(
        await startBrowserRecording(
          browserSessionId,
          String(call.input.name || ""),
        ),
        null,
        2,
      ),
    };
  if (call.name === "browser_record_stop")
    return {
      output: JSON.stringify(
        await stopBrowserRecording(browserSessionId),
        null,
        2,
      ),
    };
  if (call.name === "ssh_connect") {
    const result = await connectSsh(
      browserSessionId,
      requestId,
      {
        host: String(call.input.host || ""),
        port: Number(call.input.port) || 22,
        username: String(call.input.username || ""),
        password:
          typeof call.input.password === "string"
            ? call.input.password
            : undefined,
        privateKey:
          typeof call.input.privateKey === "string"
            ? call.input.privateKey
            : undefined,
        passphrase:
          typeof call.input.passphrase === "string"
            ? call.input.passphrase
            : undefined,
      },
      signal,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "ssh_run") {
    const remoteCommand = String(call.input.command || "");
    const result = await runSshCommand(
      browserSessionId,
      requestId,
      remoteCommand,
      signal,
      {
        stdin:
          typeof call.input.stdin === "string" ? call.input.stdin : undefined,
        pty: Boolean(call.input.pty),
        timeoutMs: Math.min(
          600_000,
          Math.max(1_000, Number(call.input.timeoutMs) || 180_000),
        ),
        onOutput: onProgress,
      },
    );
    return { ...result, command: remoteCommand };
  }
  if (call.name === "ssh_list_directory") {
    const remotePath = String(call.input.path || ".");
    return {
      path: remotePath,
      output: JSON.stringify(
        await listSshDirectory(browserSessionId, requestId, remotePath, signal),
        null,
        2,
      ),
    };
  }
  if (call.name === "ssh_read_file") {
    const remotePath = String(call.input.path || "");
    return {
      path: remotePath,
      output: await readSshFile(
        browserSessionId,
        requestId,
        remotePath,
        signal,
      ),
    };
  }
  if (call.name === "ssh_write_file") {
    const remotePath = String(call.input.path || "");
    const result = await writeSshFile(
      browserSessionId,
      requestId,
      activityId,
      remotePath,
      String(call.input.content ?? ""),
      signal,
    );
    return {
      path: remotePath,
      output: `已原子写入远程文件，共 ${result.bytes} 字节`,
      undoable: true,
      ...diffFor(remotePath, result.before, result.after),
    };
  }
  if (call.name === "ssh_upload_file") {
    const localPath = path.resolve(String(call.input.localPath || ""));
    const remotePath = String(call.input.remotePath || "");
    const result = await uploadSshFile(
      browserSessionId,
      requestId,
      localPath,
      remotePath,
      signal,
      onProgress,
    );
    return {
      path: remotePath,
      output: `已上传本地文件到远程 ${remotePath}，共 ${result.bytes} 字节`,
    };
  }
  if (call.name === "ssh_download_file") {
    const remotePath = String(call.input.remotePath || "");
    const localPath = path.resolve(String(call.input.localPath || ""));
    const result = await downloadSshFile(
      browserSessionId,
      requestId,
      remotePath,
      localPath,
      signal,
    );
    return {
      path: localPath,
      output: `已下载远程文件到本地 ${localPath}，共 ${result.bytes} 字节`,
    };
  }
  if (call.name === "ssh_disconnect")
    return {
      output: disconnectSsh(browserSessionId)
        ? "SSH 连接已断开"
        : "当前任务没有活动的 SSH 连接",
    };
  if (call.name === "mysql_connect") {
    const result = await connectMysql(
      browserSessionId,
      requestId,
      mysqlConnectInput(call.input),
      false,
      signal,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "mysql_connect_via_ssh") {
    let mysqlSessionId = browserSessionId;
    if (call.input.sshHost) {
      mysqlSessionId = `${browserSessionId}:pending:${activityId}`;
      await connectSsh(
        mysqlSessionId,
        requestId,
        {
          host: String(call.input.sshHost),
          port: Number(call.input.sshPort) || 22,
          username: String(call.input.sshUsername || ""),
          password:
            typeof call.input.sshPassword === "string"
              ? call.input.sshPassword
              : undefined,
          privateKey:
            typeof call.input.sshPrivateKey === "string"
              ? call.input.sshPrivateKey
              : undefined,
          passphrase:
            typeof call.input.sshPassphrase === "string"
              ? call.input.sshPassphrase
              : undefined,
        },
        signal,
      );
    }
    let result;
    try {
      result = await connectMysql(
        mysqlSessionId,
        requestId,
        mysqlConnectInput(call.input, "127.0.0.1"),
        true,
        signal,
      );
      if (mysqlSessionId !== browserSessionId) {
        adoptMysqlSession(mysqlSessionId, browserSessionId);
        adoptSshSession(mysqlSessionId, browserSessionId);
      }
    } catch (error) {
      if (mysqlSessionId !== browserSessionId) {
        await disconnectMysql(mysqlSessionId);
        disconnectSsh(mysqlSessionId);
      }
      throw error;
    }
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "mysql_query") {
    const sql = String(call.input.sql || "");
    const values = Array.isArray(call.input.values) ? call.input.values : [];
    return {
      command: sql,
      output: await queryMysql(
        browserSessionId,
        requestId,
        sql,
        values,
        signal,
      ),
    };
  }
  if (call.name === "mysql_disconnect")
    return {
      output: (await disconnectMysql(browserSessionId))
        ? "MySQL 连接已关闭"
        : "当前任务没有活动的 MySQL 连接",
    };
  if (call.name === "sqlserver_connect") {
    const result = await connectSqlServer(
      browserSessionId,
      requestId,
      sqlServerConnectInput(call.input),
      false,
      signal,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "sqlserver_connect_via_ssh") {
    let sessionId = browserSessionId;
    if (call.input.sshHost) {
      sessionId = `${browserSessionId}:pending:${activityId}`;
      await connectSsh(
        sessionId,
        requestId,
        {
          host: String(call.input.sshHost),
          port: Number(call.input.sshPort) || 22,
          username: String(call.input.sshUsername || ""),
          password:
            typeof call.input.sshPassword === "string"
              ? call.input.sshPassword
              : undefined,
          privateKey:
            typeof call.input.sshPrivateKey === "string"
              ? call.input.sshPrivateKey
              : undefined,
          passphrase:
            typeof call.input.sshPassphrase === "string"
              ? call.input.sshPassphrase
              : undefined,
        },
        signal,
      );
    }
    try {
      const result = await connectSqlServer(
        sessionId,
        requestId,
        sqlServerConnectInput(call.input, "127.0.0.1"),
        true,
        signal,
      );
      if (sessionId !== browserSessionId) {
        adoptSqlServerSession(sessionId, browserSessionId);
        adoptSshSession(sessionId, browserSessionId);
      }
      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      if (sessionId !== browserSessionId) {
        await disconnectSqlServer(sessionId);
        disconnectSsh(sessionId);
      }
      throw error;
    }
  }
  if (call.name === "sqlserver_query") {
    const sql = String(call.input.sql || "");
    const values = Array.isArray(call.input.values) ? call.input.values : [];
    return {
      command: sql,
      output: await querySqlServer(
        browserSessionId,
        requestId,
        sql,
        values,
        signal,
      ),
    };
  }
  if (call.name === "sqlserver_disconnect")
    return {
      output: (await disconnectSqlServer(browserSessionId))
        ? "SQL Server 连接已关闭"
        : "当前任务没有活动的 SQL Server 连接",
    };
  if (call.name === "mongodb_connect") {
    const result = await connectMongo(
      browserSessionId,
      requestId,
      mongoConnectInput(call.input),
      false,
      signal,
    );
    return { output: JSON.stringify(result, null, 2) };
  }
  if (call.name === "mongodb_connect_via_ssh") {
    let sessionId = browserSessionId;
    if (call.input.sshHost) {
      sessionId = `${browserSessionId}:pending:${activityId}`;
      await connectSsh(
        sessionId,
        requestId,
        {
          host: String(call.input.sshHost),
          port: Number(call.input.sshPort) || 22,
          username: String(call.input.sshUsername || ""),
          password:
            typeof call.input.sshPassword === "string"
              ? call.input.sshPassword
              : undefined,
          privateKey:
            typeof call.input.sshPrivateKey === "string"
              ? call.input.sshPrivateKey
              : undefined,
          passphrase:
            typeof call.input.sshPassphrase === "string"
              ? call.input.sshPassphrase
              : undefined,
        },
        signal,
      );
    }
    try {
      const result = await connectMongo(
        sessionId,
        requestId,
        mongoConnectInput(call.input, "127.0.0.1"),
        true,
        signal,
      );
      if (sessionId !== browserSessionId) {
        adoptMongoSession(sessionId, browserSessionId);
        adoptSshSession(sessionId, browserSessionId);
      }
      return { output: JSON.stringify(result, null, 2) };
    } catch (error) {
      if (sessionId !== browserSessionId) {
        await disconnectMongo(sessionId);
        disconnectSsh(sessionId);
      }
      throw error;
    }
  }
  if (call.name === "mongodb_execute")
    return {
      output: await executeMongo(
        browserSessionId,
        requestId,
        call.input as any,
        signal,
      ),
    };
  if (call.name === "mongodb_disconnect")
    return {
      output: (await disconnectMongo(browserSessionId))
        ? "MongoDB 连接已关闭"
        : "当前任务没有活动的 MongoDB 连接",
    };
  if (call.name === "spawn_agent") {
    if ((request.agentDepth ?? 0) >= 2)
      throw new Error("当前子 Agent 已达到委派深度，不能继续创建下级 Agent。");
    const task = String(call.input.task || "").trim();
    if (!task) throw new Error("缺少子 Agent 任务目标。");
    const name = String(call.input.name || "").trim();
    const state = spawnSubagent(
      requestId,
      name,
      task,
      signal,
      (childRequestId, agentId, childSignal) =>
        runAgent(
          childRequestId,
          {
            ...request,
            taskId: `${request.taskId || requestId}:subagent:${agentId}`,
            agentDepth: (request.agentDepth ?? 0) + 1,
            permissionPolicy: permissionPolicyForSubagent(
              request.permissionMode,
              request.permissionPolicy,
            ),
            messages: [
              {
                role: "user",
                content: `你是主 Agent 委派的子 Agent。请独立完成以下任务并向主 Agent 返回准确、简洁、可验证的结果。不要等待用户补充信息；遇到阻碍时说明已检查的内容和具体阻碍。避免修改其他子 Agent 可能负责的文件。\n\n任务：${task}`,
              },
            ],
          },
          childSignal,
        ),
    );
    return { output: JSON.stringify(state, null, 2) };
  }
  if (call.name === "list_agents")
    return {
      output: JSON.stringify(listSubagents(requestId), null, 2),
    };
  if (call.name === "message_agent")
    return {
      output: JSON.stringify(
        messageSubagent(
          requestId,
          String(call.input.agentId || ""),
          String(call.input.message || ""),
        ),
        null,
        2,
      ),
    };
  if (call.name === "wait_agent") {
    const agentIds = Array.isArray(call.input.agentIds)
      ? call.input.agentIds.map(String)
      : undefined;
    const results = await waitForSubagents(requestId, agentIds);
    const childActivities = results.flatMap((result) => result.activityRecords);
    const visible = results.map(
      ({ activityRecords: _records, usageDelta: _usageDelta, ...result }) =>
        result,
    );
    return {
      output: JSON.stringify(visible, null, 2),
      childActivities,
      subagentUsage: results.reduce(
        (total, result) => ({
          input: total.input + result.usageDelta.input,
          output: total.output + result.usageDelta.output,
          cached: total.cached + result.usageDelta.cached,
        }),
        { input: 0, output: 0, cached: 0 },
      ),
      additions: childActivities.reduce(
        (sum, activity) => sum + (activity.additions ?? 0),
        0,
      ),
      deletions: childActivities.reduce(
        (sum, activity) => sum + (activity.deletions ?? 0),
        0,
      ),
    };
  }
  if (call.name === "stop_agent") {
    const result = await stopSubagent(
      requestId,
      String(call.input.agentId || ""),
    );
    const { activityRecords, usageDelta, ...visible } = result;
    return {
      output: JSON.stringify(visible, null, 2),
      childActivities: activityRecords,
      subagentUsage: usageDelta,
    };
  }
  if (call.name === "diagnostics") {
    const kind = String(call.input.kind || "");
    if (!new Set(["typecheck", "test", "lint", "build"]).has(kind))
      throw new Error("不支持的诊断类型");
    const diagnostic = await resolveProjectDiagnostic(
      root,
      kind as DiagnosticKind,
    );
    if (!diagnostic.script)
      return {
        command: "未执行",
        output: diagnostic.message ?? "项目未配置对应诊断脚本，已跳过。",
      };
    const result = await command(
      root,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        powershellCommand(diagnostic.command!),
      ],
      signal,
      120_000,
    );
    return {
      command: diagnostic.command,
      output: result.output || "诊断未产生输出",
      exitCode: result.exitCode,
    };
  }
  const script = String(call.input.command || "");
  if (!script) throw new Error("缺少命令");
  const timeoutMs = Math.min(
    600_000,
    Math.max(1_000, Number(call.input.timeoutMs) || 120_000),
  );
  // Network CLIs like plink/ssh-keyscan often print nothing until they finish
  // or hang. Cap silence so the UI is not stuck for the full timeout.
  const idleTimeoutMs = isLikelyNetworkCommand(script)
    ? Math.min(90_000, timeoutMs)
    : undefined;
  const result = await command(
    root,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", powershellCommand(script)],
    signal,
    timeoutMs,
    onProgress,
    idleTimeoutMs,
  );
  return {
    output: result.output || "命令未产生输出",
    command: script,
    exitCode: result.exitCode,
  };
}

async function* sseJson(
  response: Response,
  signal: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<any> {
  if (!response.body) throw new Error("模型没有返回响应流");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await readStreamChunk(
      reader,
      signal,
      idleTimeoutMs,
    );
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks)
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "__sse_done" };
          continue;
        }
        if (data) yield JSON.parse(data);
      }
    if (done) break;
  }
}

async function parseStreamedTurn(
  protocol: string,
  response: Response,
  signal: AbortSignal,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  idleTimeoutMs?: number,
): Promise<Turn> {
  if (response.body) {
    const assembler = new AgentStreamAssembler(
      protocol as any,
      onText,
      onReasoning,
    );
    for await (const event of sseJson(response, signal, idleTimeoutMs))
      assembler.consume(event);
    assembler.assertStreamComplete();
    const assembled = assembler.finish();
    return { ...assembled, calls: validCalls(assembled.calls) };
  }
  /* Legacy inline parser retained temporarily as a compatibility reference. */
  let text = "",
    usage = { input: 0, output: 0, cached: 0 };
  const calls = new Map<
    number,
    { id: string; name: string; args: string; raw?: any }
  >();
  const responseItems: any[] = [],
    anthropicBlocks: any[] = [];
  for await (const event of sseJson(response, signal)) {
    if (event.error?.message || event.type === "error")
      throw new Error(
        event.error?.message || event.message || "模型流式请求失败",
      );
    if (protocol === "openai-chat") {
      const delta = event.choices?.[0]?.delta ?? {};
      if (delta.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0,
          current = calls.get(index) ?? {
            id: part.id || randomUUID(),
            name: "",
            args: "",
          };
        if (part.id) current.id = part.id;
        current.name += part.function?.name || "";
        current.args += part.function?.arguments || "";
        calls.set(index, current);
      }
      if (event.usage)
        usage = {
          input: event.usage.prompt_tokens ?? usage.input,
          output: event.usage.completion_tokens ?? usage.output,
          cached:
            event.usage.prompt_tokens_details?.cached_tokens ??
            event.usage.prompt_cache_hit_tokens ??
            usage.cached,
        };
    } else if (protocol === "openai-responses") {
      if (event.type === "response.output_text.delta" && event.delta) {
        text += event.delta;
        onText?.(event.delta);
      }
      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const index = event.output_index ?? calls.size;
        calls.set(index, {
          id: event.item.call_id || event.item.id || randomUUID(),
          name: event.item.name || "",
          args: event.item.arguments || "",
          raw: event.item,
        });
      }
      if (event.type === "response.function_call_arguments.delta") {
        const index = event.output_index ?? 0,
          current = calls.get(index) ?? {
            id: event.call_id || event.item_id || randomUUID(),
            name: event.name || "",
            args: "",
          };
        current.args += event.delta || "";
        calls.set(index, current);
      }
      if (event.type === "response.output_item.done" && event.item)
        responseItems.push(event.item);
      if (event.response?.usage)
        usage = {
          input: event.response.usage.input_tokens ?? usage.input,
          output: event.response.usage.output_tokens ?? usage.output,
          cached:
            event.response.usage.input_tokens_details?.cached_tokens ??
            usage.cached,
        };
    } else if (protocol === "anthropic-messages") {
      if (event.type === "message_start")
        usage.input = event.message?.usage?.input_tokens ?? usage.input;
      if (event.type === "content_block_start") {
        anthropicBlocks[event.index] = event.content_block;
        if (event.content_block?.type === "tool_use")
          calls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            args: "",
            raw: event.content_block,
          });
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        text += event.delta.text || "";
        onText?.(event.delta.text || "");
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const current = calls.get(event.index);
        if (current)
          current.args = current.args + (event.delta.partial_json || "");
      }
      if (event.type === "message_delta")
        usage.output = event.usage?.output_tokens ?? usage.output;
    } else {
      const parts = event.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string") {
          text += part.text;
          onText?.(part.text);
        }
        if (part.functionCall)
          calls.set(calls.size, {
            id: randomUUID(),
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args ?? {}),
            raw: part,
          });
      }
      if (event.usageMetadata)
        usage = {
          input: event.usageMetadata.promptTokenCount ?? usage.input,
          output: event.usageMetadata.candidatesTokenCount ?? usage.output,
          cached: event.usageMetadata.cachedContentTokenCount ?? usage.cached,
        };
    }
  }
  const parsedCalls = [...calls.values()].map((call) => ({
    id: call.id,
    name: call.name as AgentToolName,
    input: JSON.parse(call.args || "{}"),
  }));
  let rawCalls: unknown[] = [];
  if (protocol === "openai-chat")
    rawCalls = [
      {
        message: {
          role: "assistant",
          content: text || null,
          tool_calls: [...calls.values()].map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args || "{}" },
          })),
        },
      },
    ];
  else if (protocol === "openai-responses")
    rawCalls = responseItems.filter((item) => item.type === "function_call");
  else if (protocol === "anthropic-messages")
    rawCalls = anthropicBlocks
      .filter((block) => block?.type === "tool_use")
      .map((block, index) => ({
        ...block,
        input: parsedCalls[index]?.input ?? {},
      }));
  else rawCalls = [...calls.values()].map((call) => call.raw).filter(Boolean);
  return { text, calls: validCalls(parsedCalls), rawCalls, usage };
}

type TurnStreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "complete"; turn: Turn };
async function* streamModelTurn(
  root: string,
  requestId: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled: boolean,
  requireToolCall: boolean,
): AsyncGenerator<TurnStreamEvent> {
  const queue: TurnStreamEvent[] = [];
  let wake: (() => void) | undefined,
    done = false,
    turn: Turn | undefined,
    failure: unknown,
    emittedText = false;
  const enqueue = (event: TurnStreamEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const pushText = (delta: string) => {
    if (!delta) return;
    emittedText = true;
    enqueue({ type: "text", delta });
  };
  const pushReasoning = (delta: string) => {
    if (delta) enqueue({ type: "reasoning", delta });
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  // Retry a mid-stream failure only while nothing visible has been emitted yet,
  // so a retry can never duplicate answer text. Reasoning-only progress is safe
  // to replay. Up to two backoff retries before giving up.
  const run = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        turn = await modelTurn(
          root,
          requestId,
          request,
          history,
          signal,
          toolsEnabled,
          requireToolCall,
          pushText,
          pushReasoning,
        );
        return;
      } catch (error) {
        if (
          signal.aborted ||
          emittedText ||
          attempt >= 3 ||
          !isRetryableStreamError(error)
        )
          throw error;
        const delay =
          2_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 750);
        pushReasoning(
          `上游暂时不可用，${Math.ceil(delay / 1_000)} 秒后自动重试（第 ${attempt} 次）…`,
        );
        await sleep(delay);
        if (signal.aborted) throw error;
      }
    }
  };
  void run()
    .then(() => {
      done = true;
      wake?.();
    })
    .catch((error) => {
      failure = error;
      done = true;
      wake?.();
    });
  while (!done || queue.length) {
    if (!queue.length)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    while (queue.length) yield queue.shift()!;
  }
  if (failure) throw failure;
  yield { type: "complete", turn: turn! };
}

async function modelTurn(
  root: string,
  requestId: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled = true,
  requireToolCall = false,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  protocolOverride?: Protocol,
): Promise<Turn> {
  const provider = await getProviderWithKey(request.providerId);
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  )!;
  const protocol =
    protocolOverride ??
    effectiveOpenAiProtocol(provider.id, provider.protocol);
  const reasoning = {
    ...inferReasoningConfig(selectedModel.modelId, protocol),
    reasoningMode:
      selectedModel.reasoningMode ??
      inferReasoningConfig(selectedModel.modelId, protocol).reasoningMode,
  };
  const effort = request.reasoningEffort ?? "auto";
  const budgets: Partial<Record<ReasoningEffort, number>> = {
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  const runtimeTools = toolsEnabled
    ? tools.filter(
        (tool) =>
          !((request.agentDepth ?? 0) >= 2 && tool.name === "spawn_agent"),
      )
    : [];
  const isolation = createConversationIsolation(request.taskId, requestId);
  const system = `${isolation.boundary}\nYou are a coding agent working in ${root}. Use the provided native tools to inspect and modify the project. Each run_command invocation uses a fresh PowerShell process, so environment variable changes do not persist to later commands; combine dependent setup and execution in one command. Prefer apply_patch for precise edits and write_file for new or complete files. Never invoke apply_patch, file deletion, file moves, or directory operations through run_command when a native tool exists. File tool paths accept absolute paths, including other drives (for example D:\\B on Windows); use them to read or write files the user explicitly points to outside ${root}, and resolve relative paths against ${root}. When you mention a file in your reply, always write its full workspace-relative path (for example src/views/Gooddetail.vue, not just Gooddetail.vue) so the user can tell exactly which file it is. Use web_search for current or externally verifiable information and fetch_url to inspect primary sources; preserve source URLs in the final answer. For interactive or authenticated sites use browser_open, browser_snapshot, browser_click, and browser_type. Credentials explicitly supplied by the user may be entered directly with browser_type. Browser recording is opt-in: call browser_record_start only after an explicit user request such as 开始录制, and call browser_record_stop when the user asks to stop or generate Python. Never record ordinary browsing by default. For independent work that can run concurrently, use spawn_agent with self-contained, non-overlapping tasks, then wait_agent before giving a final answer. Use list_agents, message_agent, and stop_agent to coordinate them. Subagents inherit this task's model, workspace, reasoning, and permissions. For remote servers, call ssh_connect with credentials explicitly supplied by the user, then use ssh_run and the SSH SFTP tools. Use ssh_upload_file to send a local file to the server and ssh_download_file to fetch a remote file to a local path; these transfer binary content directly, unlike ssh_write_file which only writes inline UTF-8 text. SSH exec sessions are non-interactive and may not load shell profiles; when a remote command depends on profile-defined PATH values, invoke the appropriate login shell explicitly. SSH host keys are not verified. Credentials supplied by the user may appear in commands, tool activity details, subagent tasks, and conversation text. For databases, use mysql_connect for direct MySQL access or mysql_connect_via_ssh for an SSH tunnel, then mysql_query; use ? placeholders and values for user-provided data when practical. Public direct MySQL connections use TLS by default and you must not retry with ssl=false unless the user explicitly approves. If CAPTCHA, SMS, passkey, or two-factor verification appears, pause and ask the user to complete it in the visible browser. Do not claim an action succeeded until its tool result confirms it.${request.recoveryContext ? `\n\n<recovery_context>${request.recoveryContext}</recovery_context>\nThis task resumed after an interruption. Verify prior side effects before repeating them, and recreate any interrupted subagent work that is still needed.` : ""}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...isolation.headers,
  };
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini-generate-content") {
    /* Gemini uses a query-string key. */
  } else headers.Authorization = `Bearer ${provider.apiKey}`;
  let url = "",
    body: Record<string, unknown> = {};
  if (protocol === "openai-chat") {
    url = apiEndpoint(provider.baseUrl, "chat/completions");
    const messages: unknown[] = [{ role: "system", content: system }];
    for (const item of history) {
      if (item.kind === "message") {
        const content = item.images?.length
          ? [
              { type: "text", text: item.content },
              ...item.images.map((image) => ({
                type: "image_url",
                image_url: { url: image.dataUrl },
              })),
            ]
          : item.content;
        // Some OpenAI-compatible gateways reject empty assistant messages.
        if (item.role === "assistant" && !content) continue;
        messages.push({ role: item.role, content });
      }
      else if (item.kind === "calls") {
        const raw = item.rawCalls[0] as Record<string, unknown> | undefined;
        const message: Record<string, unknown> = {
          ...((raw?.message as Record<string, unknown> | undefined) ?? {
            role: "assistant",
            content: raw?.content,
            reasoning_content: raw?.reasoning_content,
            reasoning_details: raw?.reasoning_details,
            tool_calls: raw?.tool_calls,
          }),
          tool_calls:
            (raw?.message as Record<string, unknown> | undefined)?.tool_calls ??
            raw?.tool_calls ??
            item.calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
        };
        if (!message.content) delete message.content;
        messages.push(message);
      } else
        messages.push({
          role: "tool",
          tool_call_id: item.callId,
          content: item.content,
        });
    }
    body = {
      model: request.modelId,
      ...isolation.openAi,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(runtimeTools.length
        ? {
            tools: runtimeTools.map((t) => ({ type: "function", function: t })),
            ...(requireToolCall ? { tool_choice: "required" } : {}),
          }
        : {}),
      reasoning_effort:
        reasoning.reasoningMode === "effort" &&
        !["auto", "thinking"].includes(effort)
          ? effort
          : undefined,
      thinking:
        reasoning.reasoningMode === "fixed"
          ? { type: "enabled" }
          : reasoning.reasoningMode === "toggle"
            ? { type: effort === "thinking" ? "enabled" : "disabled" }
            : undefined,
      reasoning_split: /api\.minimaxi\.com/i.test(provider.baseUrl)
        ? true
        : undefined,
    };
  } else if (protocol === "openai-responses") {
    url = apiEndpoint(provider.baseUrl, "responses");
    const input: unknown[] = [{ role: "developer", content: system }];
    for (const item of history) {
      if (item.kind === "message")
        input.push({
          role: item.role,
          content: item.images?.length
            ? [
                { type: "input_text", text: item.content },
                ...item.images.map((image) => ({
                  type: "input_image",
                  image_url: image.dataUrl,
                })),
              ]
            : item.content,
        });
      else if (item.kind === "calls")
        input.push(
          ...(item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: JSON.stringify(c.input),
              }))),
        );
      else
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output: item.content,
        });
    }
    body = {
      model: request.modelId,
      input,
      stream: true,
      ...(runtimeTools.length
        ? { tools: runtimeTools.map((t) => ({ type: "function", ...t })) }
        : {}),
      reasoning:
        reasoning.reasoningMode === "effort" &&
        !["auto", "thinking"].includes(effort)
          ? { effort }
          : undefined,
    };
  } else if (protocol === "anthropic-messages") {
    url = apiEndpoint(provider.baseUrl, "messages");
    const messages: { role: string; content: unknown }[] = [];
    for (const item of history) {
      if (item.kind === "message")
        messages.push({
          role: item.role,
          content: item.images?.length
            ? [
                { type: "text", text: item.content },
                ...item.images.map((image) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mediaType,
                    data: base64Data(image.dataUrl),
                  },
                })),
              ]
            : item.content,
        });
      else if (item.kind === "calls")
        messages.push({
          role: "assistant",
          content: item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((c) => ({
                type: "tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              })),
        });
      else
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.callId,
              content: item.content,
            },
          ],
        });
    }
    body = {
      model: request.modelId,
      system,
      messages,
      max_tokens: 4096,
      stream: true,
      thinking:
        reasoning.reasoningMode === "budget" && effort !== "auto"
          ? { type: "enabled", budget_tokens: budgets[effort] ?? 8192 }
          : undefined,
      ...(runtimeTools.length
        ? {
            tools: runtimeTools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };
  } else {
    url = `${trim(provider.baseUrl)}/v1beta/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey)}`;
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const item of history) {
      if (item.kind === "message")
        contents.push({
          role: item.role === "assistant" ? "model" : "user",
          parts: [
            { text: item.content },
            ...(item.images ?? []).map((image) => ({
              inlineData: {
                mimeType: image.mediaType,
                data: base64Data(image.dataUrl),
              },
            })),
          ],
        });
      else if (item.kind === "calls")
        contents.push({
          role: "model",
          parts: item.rawCalls.length
            ? item.rawCalls
            : item.calls.map((call) => ({
                functionCall: { name: call.name, args: call.input },
              })),
        });
      else {
        const call = [...history]
          .reverse()
          .find(
            (entry) =>
              entry.kind === "calls" &&
              entry.calls.some((candidate) => candidate.id === item.callId),
          );
        const name =
          call?.kind === "calls"
            ? call.calls.find((candidate) => candidate.id === item.callId)?.name
            : undefined;
        contents.push({
          role: "user",
          parts: [
            { functionResponse: { name, response: { result: item.content } } },
          ],
        });
      }
    }
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig:
        reasoning.reasoningMode === "budget"
          ? {
              thinkingConfig:
                effort === "auto"
                  ? undefined
                  : { thinkingBudget: budgets[effort] ?? 8192 },
            }
          : undefined,
      ...(runtimeTools.length
        ? {
            tools: [
              {
                functionDeclarations: runtimeTools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ],
          }
        : {}),
    };
  }
  // Reasoning models can spend minutes thinking before the first byte arrives,
  // especially behind a third-party proxy with a large context. Keep a shorter
  // bound for regular models while progress events make either wait observable.
  const firstByteTimeoutMs =
    reasoning.reasoningMode !== "none" ? 300_000 : 90_000;
  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    {
      signal,
      firstByteTimeoutMs,
      retries: 1,
      retryDelayMs: 2_000,
    },
  );
  writeLog("info", "model.response", {
    requestId: isolation.traceId,
    taskScopeId: isolation.taskScopeId,
    conversationId: isolation.conversationId,
    providerId: request.providerId,
    modelId: request.modelId,
    protocol,
    status: response.status,
    requestBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
    toolCount: runtimeTools.length,
    historyHash: historyFingerprint(history),
    upstreamRequestId:
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined,
  });
  if (
    protocol === "openai-responses" &&
    shouldFallbackResponses(provider.baseUrl, response.status)
  ) {
    await response.body?.cancel().catch(() => undefined);
    rememberChatFallback(provider.id);
    onReasoning?.(
      `Responses API 返回 ${response.status}，已自动切换到 Chat Completions 兼容接口…`,
    );
    writeLog("warn", "model.protocolFallback", {
      requestId: isolation.traceId,
      providerId: provider.id,
      modelId: request.modelId,
      from: "openai-responses",
      to: "openai-chat",
      status: response.status,
    });
    return modelTurn(
      root,
      requestId,
      request,
      history,
      signal,
      toolsEnabled,
      requireToolCall,
      onText,
      onReasoning,
      "openai-chat",
    );
  }
  if (!response.ok)
    throw new Error(
      `请求失败 (${response.status}): ${(await readResponseText(response, signal)).slice(0, 500)}`,
    );
  if (/text\/event-stream/i.test(response.headers.get("content-type") || ""))
    return parseStreamedTurn(
      protocol,
      response,
      signal,
      onText,
      onReasoning,
      reasoning.reasoningMode !== "none" ? 180_000 : undefined,
    );
  const json = JSON.parse(await readResponseText(response, signal)) as any;
  if (protocol === "openai-chat") {
    const message = json.choices?.[0]?.message ?? {};
    const calls = (message.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      input: JSON.parse(c.function.arguments || "{}"),
    }));
    return {
      text: message.content || "",
      calls: validCalls(calls),
      rawCalls: [
        {
          message,
          content: message.content,
          reasoning_content: message.reasoning_content,
          reasoning_details: message.reasoning_details,
          tool_calls: message.tool_calls ?? [],
        },
      ],
      usage: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
        cached:
          json.usage?.prompt_tokens_details?.cached_tokens ??
          json.usage?.prompt_cache_hit_tokens ??
          0,
      },
    };
  }
  if (protocol === "openai-responses") {
    const output = json.output ?? [];
    const calls = output
      .filter((x: any) => x.type === "function_call")
      .map((c: any) => ({
        id: c.call_id,
        name: c.name,
        input: JSON.parse(c.arguments || "{}"),
      }));
    const text = output
      .flatMap((x: any) => x.content ?? [])
      .filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text)
      .join("");
    return {
      text,
      calls: validCalls(calls),
      rawCalls: output.filter((x: any) => x.type === "function_call"),
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cached: json.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
  if (protocol === "anthropic-messages") {
    const content = json.content ?? [];
    return {
      text: content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join(""),
      calls: validCalls(
        content
          .filter((x: any) => x.type === "tool_use")
          .map((c: any) => ({ id: c.id, name: c.name, input: c.input })),
      ),
      rawCalls: content.filter((x: any) => x.type === "tool_use"),
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cached: json.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const calls = parts
    .filter((part: any) => part.functionCall)
    .map((part: any) => ({
      id: randomUUID(),
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    }));
  return {
    text: parts
      .filter((part: any) => typeof part.text === "string")
      .map((part: any) => part.text)
      .join(""),
    calls: validCalls(calls),
    rawCalls: parts.filter((part: any) => part.functionCall),
    usage: {
      input: json.usageMetadata?.promptTokenCount ?? 0,
      output: json.usageMetadata?.candidatesTokenCount ?? 0,
      cached: json.usageMetadata?.cachedContentTokenCount ?? 0,
    },
  };
}

export async function* runAgent(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const root = path.resolve(request.workspacePath);
  const browserSessionId = request.taskId || requestId;
  bindBrowserRequest(browserSessionId, requestId);
  if (!path.isAbsolute(request.workspacePath))
    throw new Error("工作区路径必须是绝对路径");
  const rootInfo = await import("node:fs/promises").then((fs) => fs.stat(root));
  if (!rootInfo.isDirectory()) throw new Error("工作区路径不是有效文件夹");
  if (
    Buffer.byteLength(JSON.stringify(request.messages), "utf8") >
    24 * 1024 * 1024
  )
    throw new Error("对话、上下文与图片总大小超过 24 MB");
  const history: HistoryItem[] = request.messages.map((m) => ({
    kind: "message",
    ...m,
  }));
  const requestedGitOps = requestedGitOperations(history);
  const requestedCodingOps = requestedCodingOperations(history);
  const toolsEnabled = !isCasualGreeting(request.messages.at(-1));
  const usage = { input: 0, output: 0, cached: 0 };
  let lastPromptTokens = 0;
  let round = 0,
    stalledRounds = 0,
    lastFingerprint = "",
    unverifiedBrowserClaims = 0,
    unverifiedGitClaims = 0,
    unverifiedCodingClaims = 0;
  while (!signal.aborted) {
    round += 1;
    if (
      request.contextWindow &&
      lastPromptTokens >= request.contextWindow * 0.92
    ) {
      const before = history.length;
      if (
        compactRuntimeHistory(
          history,
          lastPromptTokens >= request.contextWindow * 0.99,
        )
      ) {
        const activity: AgentActivity = {
          id: randomUUID(),
          requestId,
          tool: "read_many_files",
          status: "success",
          title: "压缩运行上下文",
          startedAt: Date.now(),
          completedAt: Date.now(),
          input: {},
          output: `已将 ${before} 条运行记录压缩为 ${history.length} 条，Agent 将继续执行`,
          round,
          progress: "advanced",
        };
        yield { type: "activity", activity };
        lastPromptTokens = 0;
      }
    }
    for (const message of drainSubagentMessages(requestId))
      history.push({
        kind: "message",
        role: "user",
        content: `<parent_instruction>${message}</parent_instruction>`,
      });
    let turn: Turn | undefined,
      streamedText = "";
    const bufferModelText =
      browserIsOpen(browserSessionId) ||
      requestedGitOps.size > 0 ||
      requestedCodingOps.size > 0 ||
      listSubagents(requestId).some((agent) => !agent.collected);
    for await (const event of streamModelTurn(
      root,
      requestId,
      request,
      history,
      signal,
      toolsEnabled,
      shouldRequireCodingTool(
        request.modelId,
        requestedCodingOps,
        successfulCodingEvidence(history),
      ),
    )) {
      if (event.type === "complete") turn = event.turn;
      else if (event.type === "reasoning")
        yield { type: "reasoning", delta: event.delta };
      else {
        streamedText += event.delta;
        if (!bufferModelText) yield { type: "text", delta: event.delta };
      }
    }
    if (!turn) throw new Error("模型流结束但没有完成结果");
    lastPromptTokens = turn.usage.input;
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    usage.cached += turn.usage.cached;
    // input/output/cached accumulate across rounds for billing; promptTokens is
    // the latest round's prompt size, i.e. the real current context occupancy.
    yield { type: "usage", ...usage, promptTokens: lastPromptTokens };
    const claimsBrowserAction =
      browserIsOpen(browserSessionId) &&
      !turn.calls.length &&
      /(已|已经|刚刚|现在).{0,16}(点击|选择|填写|输入|提交|发送|打开|登录|切换)|(?:clicked|selected|filled|entered|submitted|sent|opened|logged in)/i.test(
        turn.text,
      );
    if (claimsBrowserAction && unverifiedBrowserClaims < 2) {
      unverifiedBrowserClaims += 1;
      history.push({ kind: "message", role: "assistant", content: turn.text });
      history.push({
        kind: "message",
        role: "user",
        content:
          "<runtime_verification>你声称执行了网页操作，但本轮没有任何浏览器工具调用。不要描述或假设操作成功；请立即使用 browser_snapshot 获取当前页面，再调用 browser_click/browser_type 实际执行，并通过新的页面快照验证结果。</runtime_verification>",
      });
      continue;
    }
    const claimedGitOps = claimedGitOperations(turn.text);
    const gitEvidence = successfulGitEvidence(history);
    const missingGitEvidence = [...claimedGitOps].filter(
      (operation) => requestedGitOps.has(operation) && !gitEvidence.has(operation),
    );
    if (!turn.calls.length && missingGitEvidence.length) {
      if (unverifiedGitClaims < 2) {
        unverifiedGitClaims += 1;
        history.push({ kind: "message", role: "assistant", content: turn.text });
        history.push({
          kind: "message",
          role: "user",
          content: `<runtime_verification>你声称 Git/发布操作已经成功，但本次任务没有对应的成功工具结果。缺少证据：${missingGitEvidence.join(", ")}。不要重复成功结论；请实际调用工具执行操作，并在结束前用 git_status/git_log 以及 gh run list/gh run view 验证本地提交、远端推送和 Actions 运行。若无法执行，请明确报告未完成及原因。</runtime_verification>`,
        });
        continue;
      }
      yield {
        type: "text",
        delta: `未检测到可验证的 Git/发布工具结果，无法确认以下操作已经完成：${missingGitEvidence.join(", ")}。`,
      };
      closeSubagentMessageQueue(requestId);
      yield { type: "done" };
      return;
    }
    const claimedCodingOps = claimedCodingOperations(turn.text);
    const codingEvidence = successfulCodingEvidence(history);
    const missingCodingEvidence = [...claimedCodingOps].filter(
      (operation) =>
        requestedCodingOps.has(operation) && !codingEvidence.has(operation),
    );
    if (!turn.calls.length && missingCodingEvidence.length) {
      if (unverifiedCodingClaims < 2) {
        unverifiedCodingClaims += 1;
        history.push({ kind: "message", role: "assistant", content: turn.text });
        history.push({
          kind: "message",
          role: "user",
          content: `<runtime_verification>你声称编码任务已经完成，但本次任务没有对应的成功工具结果。缺少证据：${missingCodingEvidence.join(", ")}。不要继续总结或假设文件已经改变；请立即使用工作区工具实际检查和修改，并用 diagnostics 或真实命令验证。若无法执行，请明确报告未完成及原因。</runtime_verification>`,
        });
        continue;
      }
      yield {
        type: "text",
        delta: `未检测到可验证的编码工具结果，无法确认以下操作已经完成：${missingCodingEvidence.join(", ")}。文件没有被 KCode 确认修改。`,
      };
      closeSubagentMessageQueue(requestId);
      yield { type: "done" };
      return;
    }
    if (!turn.calls.length) {
      const lateInstructions = drainSubagentMessages(requestId);
      const uncollectedAgents = listSubagents(requestId).filter(
        (agent) => !agent.collected,
      );
      if (lateInstructions.length || uncollectedAgents.length) {
        if (turn.text)
          history.push({
            kind: "message",
            role: "assistant",
            content: turn.text,
          });
        for (const message of lateInstructions)
          history.push({
            kind: "message",
            role: "user",
            content: `<parent_instruction>${message}</parent_instruction>`,
          });
        if (uncollectedAgents.length)
          history.push({
            kind: "message",
            role: "user",
            content: `<runtime_verification>仍有 ${uncollectedAgents.length} 个子 Agent 尚未收集结果。请调用 wait_agent 等待并汇总，或调用 stop_agent 停止后收集；不要在此之前结束任务。</runtime_verification>`,
          });
        continue;
      }
    }
    if (turn.text && (bufferModelText || !streamedText)) {
      history.push({ kind: "message", role: "assistant", content: turn.text });
      yield { type: "text", delta: turn.text };
    } else if (turn.text)
      history.push({ kind: "message", role: "assistant", content: turn.text });
    if (!turn.calls.length) {
      closeSubagentMessageQueue(requestId);
      yield { type: "done" };
      return;
    }
    history.push({ kind: "calls", calls: turn.calls, rawCalls: turn.rawCalls });
    const roundFingerprints: string[] = [];
    let roundAdvanced = false;
    for (const call of turn.calls) {
      const titles: Record<AgentToolName, string> = {
        list_directory: "查看目录",
        glob_files: "查找文件",
        read_many_files: "批量读取",
        path_info: "检查路径",
        read_file: "读取文件",
        search_code: "搜索代码",
        apply_patch: "应用补丁",
        write_file: "修改文件",
        make_directory: "创建目录",
        move_path: "移动文件",
        delete_path: "删除路径",
        git_status: "Git 状态",
        git_diff: "Git 差异",
        git_log: "Git 日志",
        git_show: "Git 查看",
        start_process: "启动进程",
        process_output: "进程输出",
        stop_process: "停止进程",
        diagnostics: "项目诊断",
        web_search: "搜索互联网",
        fetch_url: "读取网页",
        browser_open: "打开浏览器",
        browser_snapshot: "查看网页",
        browser_click: "点击网页",
        browser_type: "填写网页",
        browser_screenshot: "网页截图",
        browser_record_start: "开始网页录制",
        browser_record_stop: "停止网页录制",
        ssh_connect: "连接 SSH",
        ssh_run: "运行远程命令",
        ssh_list_directory: "查看远程目录",
        ssh_read_file: "读取远程文件",
        ssh_write_file: "修改远程文件",
        ssh_upload_file: "上传文件到远程",
        ssh_download_file: "从远程下载文件",
        ssh_disconnect: "断开 SSH",
        mysql_connect: "连接 MySQL",
        mysql_connect_via_ssh: "通过 SSH 连接 MySQL",
        mysql_query: "执行 SQL",
        mysql_disconnect: "断开 MySQL",
        sqlserver_connect: "连接 SQL Server",
        sqlserver_connect_via_ssh: "通过 SSH 连接 SQL Server",
        sqlserver_query: "执行 T-SQL",
        sqlserver_disconnect: "断开 SQL Server",
        mongodb_connect: "连接 MongoDB",
        mongodb_connect_via_ssh: "通过 SSH 连接 MongoDB",
        mongodb_execute: "执行 MongoDB 操作",
        mongodb_disconnect: "断开 MongoDB",
        spawn_agent: "创建子 Agent",
        list_agents: "查看子 Agent",
        message_agent: "追加子 Agent 指令",
        wait_agent: "等待子 Agent",
        stop_agent: "停止子 Agent",
        run_command: "运行命令",
      };
      const activity: AgentActivity = {
        id: randomUUID(),
        requestId,
        tool: call.name,
        status: "running",
        title: titles[call.name],
        startedAt: Date.now(),
        input:
          call.name === "spawn_agent"
            ? {
                name: String(call.input.name || ""),
                task: String(call.input.task || ""),
              }
            : call.name === "message_agent"
              ? {
                  agentId: String(call.input.agentId || ""),
                  message: String(call.input.message || ""),
                }
              : call.input,
        path:
          typeof call.input.path === "string"
            ? call.input.path
            : typeof call.input.to === "string"
              ? call.input.to
              : undefined,
        command:
          typeof call.input.command === "string"
            ? call.input.command
            : undefined,
        round,
      };
      const browserTool = call.name.startsWith("browser_");
      const mysqlSql =
        call.name === "mysql_query" ? String(call.input.sql || "").trim() : "";
      const mysqlRisk = mysqlSql ? classifyMysqlSql(mysqlSql) : undefined;
      const sqlServerSql =
        call.name === "sqlserver_query"
          ? String(call.input.sql || "").trim()
          : "";
      const sqlServerRisk = sqlServerSql
        ? classifySqlServerSql(sqlServerSql)
        : undefined;
      const mongoOperation =
        call.name === "mongodb_execute"
          ? String(call.input.operation || "")
          : "";
      const databaseRead =
        (call.name === "mysql_query" && mysqlRisk === "read") ||
        (call.name === "sqlserver_query" && sqlServerRisk === "read") ||
        (call.name === "mongodb_execute" &&
          ["find", "aggregate", "countDocuments", "distinct"].includes(
            mongoOperation,
          ));
      const databaseDelete =
        (call.name === "mysql_query" && mysqlRisk === "destructive") ||
        (call.name === "sqlserver_query" && sqlServerRisk === "destructive") ||
        (call.name === "mongodb_execute" &&
          mongoOperation.startsWith("delete"));
      const databaseTool = /^(mysql|sqlserver|mongodb)_/.test(call.name);
      const databaseConnectionTool =
        databaseTool &&
        (call.name.endsWith("connect") ||
          call.name.includes("connect_via_ssh") ||
          call.name.endsWith("disconnect"));
      const category =
        call.name === "web_search" ||
        call.name === "fetch_url" ||
        browserTool ||
        call.name === "ssh_connect" ||
        call.name === "ssh_list_directory" ||
        call.name === "ssh_read_file" ||
        call.name === "ssh_disconnect" ||
        databaseConnectionTool ||
        databaseRead
          ? "network"
          : databaseDelete
            ? "deletePaths"
            : databaseTool
              ? "workspaceWrite"
              : call.name === "ssh_run"
                ? "runCommands"
                : call.name === "ssh_write_file" ||
                    call.name === "ssh_upload_file" ||
                    call.name === "ssh_download_file"
                  ? "workspaceWrite"
                  : call.name === "delete_path"
                    ? "deletePaths"
                    : call.name === "start_process" ||
                        call.name === "stop_process"
                      ? "longRunningProcesses"
                      : call.name === "run_command"
                        ? /\bgit\s+(push|commit)\b/i.test(
                            String(call.input.command ?? ""),
                          )
                          ? "gitPublish"
                          : /\b(curl|wget|invoke-webrequest|npm\s+(install|view)|git\s+(fetch|pull|clone))\b/i.test(
                                String(call.input.command ?? ""),
                              )
                            ? "network"
                            : "runCommands"
                        : new Set<AgentToolName>([
                              "apply_patch",
                              "write_file",
                              "make_directory",
                              "move_path",
                            ]).has(call.name)
                          ? "workspaceWrite"
                          : undefined;
      const decision = resolvePermissionDecision(
        request.permissionMode,
        request.permissionPolicy,
        category,
      );
      if (decision === "deny") {
        activity.status = "denied";
        activity.completedAt = Date.now();
        activity.output =
          request.permissionMode === "read-only"
            ? "只读模式已阻止此操作"
            : "当前权限策略已阻止此操作";
        yield { type: "activity", activity };
        history.push({
          kind: "result",
          callId: call.id,
          content: activity.output,
        });
        continue;
      }
      if (decision === "confirm") {
        activity.status = "waiting";
        yield { type: "activity", activity };
        const approvalKey = `${requestId}:${activity.id}`;
        const allowed = await new Promise<boolean>((resolve) => {
          approvals.set(approvalKey, resolve);
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        });
        approvals.delete(approvalKey);
        if (!allowed) {
          activity.status = "denied";
          activity.completedAt = Date.now();
          activity.output = "用户拒绝了此操作";
          yield { type: "activity", activity };
          history.push({
            kind: "result",
            callId: call.id,
            content: activity.output,
          });
          continue;
        }
        activity.status = "running";
        yield { type: "activity", activity };
      } else yield { type: "activity", activity };
      let finishMutationClaim: ((committed: boolean) => void) | undefined;
      try {
        finishMutationClaim = claimSubagentMutation(
          requestId,
          root,
          mutationPaths(call),
        );
        const execution = streamOperationProgress((report) =>
          execute(
            root,
            requestId,
            browserSessionId,
            activity.id,
            call,
            request,
            signal,
            report,
          ),
        );
        let result: ToolResult;
        while (true) {
          const step = await execution.next();
          if (step.done) {
            result = step.value;
            break;
          }
          activity.output = step.value;
          yield { type: "activity", activity: { ...activity } };
        }
        finishMutationClaim?.(true);
        const childActivities = result.childActivities;
        const subagentUsage = result.subagentUsage;
        const {
          childActivities: _children,
          subagentUsage: _subagentUsage,
          ...activityResult
        } = result;
        const cancelled =
          signal.aborted ||
          /命令已取消|操作已取消|任务已取消/i.test(result.output || "");
        const nonZero = result.exitCode !== undefined && result.exitCode !== 0;
        const hardFailure =
          cancelled || (nonZero && isHardFailure(call, result.output));
        Object.assign(activity, activityResult, {
          status: hardFailure ? "failed" : nonZero ? "completed" : "success",
          completedAt: Date.now(),
          errorSummary: cancelled
            ? "操作已停止"
            : hardFailure
              ? failureSummary(call, result.output, result.exitCode)
              : undefined,
        });
        for (const childActivity of childActivities ?? [])
          yield {
            type: "activity",
            activity: {
              ...childActivity,
              requestId,
              round,
            },
          };
        if (subagentUsage) {
          usage.input += subagentUsage.input;
          usage.output += subagentUsage.output;
          usage.cached += subagentUsage.cached;
          // Subagent tokens count toward billing only; they do not sit in the
          // parent's context, so promptTokens stays at the parent's last round.
          yield { type: "usage", ...usage, promptTokens: lastPromptTokens };
        }
      } catch (error) {
        finishMutationClaim?.(false);
        const failureOutput =
          error instanceof Error ? error.message : String(error);
        const cancelled =
          signal.aborted ||
          /任务已取消|命令已取消|已取消|aborted|AbortError/i.test(
            failureOutput,
          );
        activity.status = "failed";
        activity.completedAt = Date.now();
        activity.output = activity.output
          ? `${activity.output}\n\n${failureOutput}`
          : failureOutput || (cancelled ? "操作已停止" : "工具执行失败");
        activity.errorSummary = cancelled
          ? "操作已停止"
          : failureSummary(call, failureOutput);
      }
      const fingerprint = JSON.stringify({
        tool: call.name,
        input: call.input,
        status: activity.status,
        output: activity.output?.slice(-2_000),
        diff: activity.diff?.slice(-2_000),
      });
      roundFingerprints.push(fingerprint);
      const advanced =
        Boolean(activity.diff) ||
        Boolean(activity.additions) ||
        Boolean(activity.deletions);
      roundAdvanced ||= advanced;
      activity.progress = advanced ? "advanced" : "unchanged";
      yield { type: "activity", activity };
      const structured: StructuredToolResult = {
        success: activity.status === "success",
        summary:
          activity.errorSummary ??
          (activity.status === "completed"
            ? `${activity.title}已执行完成，退出码 ${activity.exitCode ?? "未知"}`
            : `${activity.title}${activity.status === "success" ? "完成" : "未完成"}`),
        data: {
          output: activity.output,
          diff: activity.diff,
          path: activity.path,
          command: activity.command,
          exitCode: activity.exitCode,
          additions: activity.additions,
          deletions: activity.deletions,
          fileChanges: activity.fileChanges,
        },
        truncated: Boolean(
          activity.output && activity.output.length >= 100_000,
        ),
        error:
          activity.status === "failed"
            ? {
                message:
                  activity.errorSummary ?? activity.output ?? "工具执行失败",
                exitCode: activity.exitCode,
              }
            : undefined,
      };
      history.push({
        kind: "result",
        callId: call.id,
        content: JSON.stringify(structured),
      });
    }
    const roundFingerprint = roundFingerprints.join("|");
    const madeProgress = roundAdvanced || roundFingerprint !== lastFingerprint;
    stalledRounds = madeProgress ? 0 : stalledRounds + 1;
    lastFingerprint = roundFingerprint;
    if (signal.aborted) {
      yield {
        type: "error",
        message: "任务已停止",
      };
      return;
    }
    if (stalledRounds >= 3) {
      yield {
        type: "error",
        message: "Agent 连续 3 轮没有取得新进展，已安全暂停以避免重复执行",
      };
      return;
    }
  }
}
