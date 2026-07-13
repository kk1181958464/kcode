import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
  type ReasoningEffort,
} from "../src/types";
import { isCasualGreeting } from "../src/intent";
import { resolvePermissionDecision } from "../src/permissions";
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
    | "exitCode"
    | "undoable"
  >
> & { output: string };
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
  for (const item of older) {
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
  const summary: HistoryItem = {
    kind: "message",
    role: "user",
    content: `<runtime_compaction>较早的 Agent 工具循环已压缩。关键状态：\n${facts.slice(-80).join("\n")}</runtime_compaction>`,
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
  timeoutMs = 15_000,
) {
  let url = await validatePublicUrl(input);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, {
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
    name: "run_command",
    description: "Run a PowerShell command in the workspace.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
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
export function cleanupAgentRecords(
  requestIds: string[],
  activityIds: string[],
) {
  const requests = new Set(requestIds),
    activities = new Set(activityIds);
  for (const activityId of activities) undoSnapshots.delete(activityId);
  for (const [key, resolve] of approvals) {
    if (requests.has(key.split(":")[0])) {
      resolve(false);
      approvals.delete(key);
    }
  }
  for (const [id, process] of backgroundProcesses) {
    if (requests.has(process.requestId)) {
      process.child.kill();
      backgroundProcesses.delete(id);
    }
  }
  cleanupBrowsers(requestIds);
}
export function resolveApproval(
  requestId: string,
  activityId: string,
  allowed: boolean,
) {
  const key = `${requestId}:${activityId}`;
  approvals.get(key)?.(allowed);
  approvals.delete(key);
}

export async function undoActivity(
  workspaceRoot: string,
  activityId: string,
  force = false,
) {
  const snapshot = undoSnapshots.get(activityId);
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
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error("路径超出当前工作区");
  return resolved;
}

function command(
  root: string,
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30_000,
) {
  return new Promise<{ output: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        windowsHide: true,
        shell: false,
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      const append = (chunk: Buffer) => {
        chunks.push(chunk);
        byteLength += chunk.length;
        while (byteLength > 100_000 && chunks.length > 1)
          byteLength -= chunks.shift()!.length;
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => child.kill(), timeout);
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        const bytes = Buffer.concat(chunks);
        let output = "";
        try {
          output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          output = new TextDecoder("gb18030").decode(bytes);
        }
        resolve({ output: output.slice(-100_000), exitCode: code ?? -1 });
      });
    },
  );
}

function failureSummary(call: ToolCall, output: string, exitCode?: number) {
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
    return `命令执行失败，退出码 ${exitCode ?? "未知"}。`;
  }
  return `${({ apply_patch: "补丁应用", write_file: "文件写入", delete_path: "路径删除", move_path: "路径移动", make_directory: "目录创建", read_file: "文件读取", search_code: "代码搜索", list_directory: "目录读取", path_info: "路径检查" } as Partial<Record<AgentToolName, string>>)[call.name] || "工具执行"}失败。`;
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
    undoSnapshots.set(activityId, { root, ...change });
  }
  const diffs = changes.map((change) =>
    diffFor(
      path.relative(root, change.file).replaceAll("\\", "/"),
      change.before,
      change.after,
    ),
  );
  return {
    output: `已应用补丁，修改 ${changes.length} 个文件`,
    path:
      changes.length === 1
        ? path.relative(root, changes[0].file)
        : `${changes.length} 个文件`,
    diff: diffs.map((item) => item.diff).join("\n\n"),
    additions: diffs.reduce((sum, item) => sum + item.additions, 0),
    deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
    undoable: changes.length === 1 && Boolean(changes[0].after),
  };
}

async function execute(
  root: string,
  requestId: string,
  browserSessionId: string,
  activityId: string,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (call.name === "list_directory") {
    const directory = workspacePath(root, call.input.path);
    const recursive = Boolean(call.input.recursive);
    const entries = await readdir(directory, {
      withFileTypes: true,
      recursive,
    });
    return {
      path: path.relative(root, directory) || ".",
      output:
        entries
          .slice(0, 1000)
          .map(
            (entry) =>
              `${entry.isDirectory() ? "[dir] " : "[file]"} ${entry.parentPath ? path.relative(directory, entry.parentPath) + path.sep : ""}${entry.name}`,
          )
          .join("\n") || "目录为空",
    };
  }
  if (call.name === "glob_files") {
    const base = workspacePath(
      root,
      typeof call.input.path === "string" ? call.input.path : ".",
    );
    const pattern = String(call.input.pattern || "");
    if (!pattern) throw new Error("缺少 glob 模式");
    const result = await command(
      base,
      "rg",
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
    return {
      path: path.relative(root, base) || ".",
      output: result.output || "未找到匹配文件",
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
    const result = await command(root, "rg", args, signal, 15_000);
    if (result.exitCode > 1)
      throw new Error(result.output || `搜索失败 (${result.exitCode})`);
    return { output: result.output || "未找到匹配项" };
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
    return applyPatch(root, activityId, String(call.input.patch || ""));
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
      "git",
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
    const result = await command(root, "git", args, signal, 20_000);
    if (result.exitCode) throw new Error(result.output || "Git diff 读取失败");
    return { output: result.output || "没有差异" };
  }
  if (call.name === "git_log") {
    const limit = Math.min(50, Math.max(1, Number(call.input.limit) || 10));
    const result = await command(
      root,
      "git",
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
      "git",
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
      ["-NoProfile", "-NonInteractive", "-Command", script],
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
    process.child.kill();
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
  if (call.name === "diagnostics") {
    const kind = String(call.input.kind || "");
    const scripts = {
      typecheck: "npm run typecheck",
      test: "npm test",
      lint: "npm run lint",
      build: "npm run build",
    } as const;
    if (!(kind in scripts)) throw new Error("不支持的诊断类型");
    const result = await command(
      root,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        scripts[kind as keyof typeof scripts],
      ],
      signal,
      120_000,
    );
    return {
      command: scripts[kind as keyof typeof scripts],
      output: result.output || "诊断未产生输出",
      exitCode: result.exitCode,
    };
  }
  const script = String(call.input.command || "");
  if (!script) throw new Error("缺少命令");
  const utf8Script = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); ${script}`;
  const result = await command(
    root,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", utf8Script],
    signal,
  );
  return {
    output: result.output || "命令未产生输出",
    command: script,
    exitCode: result.exitCode,
  };
}

async function* sseJson(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error("模型没有返回响应流");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks)
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
    if (done) break;
  }
}

async function parseStreamedTurn(
  protocol: string,
  response: Response,
  onText?: (delta: string) => void,
): Promise<Turn> {
  let text = "",
    usage = { input: 0, output: 0, cached: 0 };
  const calls = new Map<
    number,
    { id: string; name: string; args: string; raw?: any }
  >();
  const responseItems: any[] = [],
    anthropicBlocks: any[] = [];
  for await (const event of sseJson(response)) {
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
        if (current) current.args += event.delta.partial_json || "";
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
  { type: "text"; delta: string } | { type: "complete"; turn: Turn };
async function* streamModelTurn(
  root: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled: boolean,
): AsyncGenerator<TurnStreamEvent> {
  const queue: string[] = [];
  let wake: (() => void) | undefined,
    done = false,
    turn: Turn | undefined,
    failure: unknown;
  const push = (delta: string) => {
    if (!delta) return;
    queue.push(delta);
    wake?.();
    wake = undefined;
  };
  void modelTurn(root, request, history, signal, toolsEnabled, push)
    .then((value) => {
      turn = value;
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
    while (queue.length) yield { type: "text", delta: queue.shift()! };
  }
  if (failure) throw failure;
  yield { type: "complete", turn: turn! };
}

async function modelTurn(
  root: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled = true,
  onText?: (delta: string) => void,
): Promise<Turn> {
  const provider = await getProviderWithKey(request.providerId);
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  )!;
  const reasoning = {
    ...inferReasoningConfig(selectedModel.modelId, selectedModel.protocol),
    reasoningMode:
      selectedModel.reasoningMode ??
      inferReasoningConfig(selectedModel.modelId, selectedModel.protocol)
        .reasoningMode,
  };
  const effort = request.reasoningEffort ?? "auto";
  const budgets: Partial<Record<ReasoningEffort, number>> = {
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  const runtimeTools = toolsEnabled ? tools : [];
  const system = `You are a coding agent working in ${root}. Use the provided native tools to inspect and modify the project. Prefer apply_patch for precise edits and write_file for new or complete files. Never invoke apply_patch, file deletion, file moves, or directory operations through run_command when a native tool exists. Use web_search for current or externally verifiable information and fetch_url to inspect primary sources; preserve source URLs in the final answer. For interactive or authenticated sites use browser_open, browser_snapshot, browser_click, and browser_type. Credentials explicitly supplied by the user may be entered directly with browser_type. Browser recording is opt-in: call browser_record_start only after an explicit user request such as 开始录制, and call browser_record_stop when the user asks to stop or generate Python. Never record ordinary browsing by default. If CAPTCHA, SMS, passkey, or two-factor verification appears, pause and ask the user to complete it in the visible browser. Do not claim an action succeeded until its tool result confirms it.`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.protocol === "anthropic-messages") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.protocol === "gemini-generate-content") {
    /* Gemini uses a query-string key. */
  } else headers.Authorization = `Bearer ${provider.apiKey}`;
  let url = "",
    body: Record<string, unknown> = {};
  if (provider.protocol === "openai-chat") {
    url = apiEndpoint(provider.baseUrl, "chat/completions");
    const messages: unknown[] = [{ role: "system", content: system }];
    for (const item of history) {
      if (item.kind === "message")
        messages.push({
          role: item.role,
          content: item.images?.length
            ? [
                { type: "text", text: item.content },
                ...item.images.map((image) => ({
                  type: "image_url",
                  image_url: { url: image.dataUrl },
                })),
              ]
            : item.content,
        });
      else if (item.kind === "calls") {
        const raw = item.rawCalls[0] as Record<string, unknown> | undefined;
        messages.push(
          raw?.message ?? {
            role: "assistant",
            content: raw?.content ?? null,
            reasoning_content: raw?.reasoning_content,
            reasoning_details: raw?.reasoning_details,
            tool_calls:
              raw?.tool_calls ??
              item.calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
          },
        );
      } else
        messages.push({
          role: "tool",
          tool_call_id: item.callId,
          content: item.content,
        });
    }
    body = {
      model: request.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(runtimeTools.length
        ? {
            tools: runtimeTools.map((t) => ({ type: "function", function: t })),
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
  } else if (provider.protocol === "openai-responses") {
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
  } else if (provider.protocol === "anthropic-messages") {
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
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok)
    throw new Error(
      `请求失败 (${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  if (/text\/event-stream/i.test(response.headers.get("content-type") || ""))
    return parseStreamedTurn(provider.protocol, response, onText);
  const json = (await response.json()) as any;
  if (provider.protocol === "openai-chat") {
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
  if (provider.protocol === "openai-responses") {
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
  if (provider.protocol === "anthropic-messages") {
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
  const toolsEnabled = !isCasualGreeting(request.messages.at(-1));
  const usage = { input: 0, output: 0, cached: 0 };
  let lastPromptTokens = 0;
  let round = 0,
    stalledRounds = 0,
    lastFingerprint = "",
    unverifiedBrowserClaims = 0;
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
    let turn: Turn | undefined,
      streamedText = "";
    const bufferBrowserText = browserIsOpen(browserSessionId);
    for await (const event of streamModelTurn(
      root,
      request,
      history,
      signal,
      toolsEnabled,
    )) {
      if (event.type === "complete") turn = event.turn;
      else {
        streamedText += event.delta;
        if (!bufferBrowserText) yield { type: "text", delta: event.delta };
      }
    }
    if (!turn) throw new Error("模型流结束但没有完成结果");
    lastPromptTokens = turn.usage.input;
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    usage.cached += turn.usage.cached;
    yield { type: "usage", ...usage };
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
    if (turn.text && (bufferBrowserText || !streamedText)) {
      history.push({ kind: "message", role: "assistant", content: turn.text });
      yield { type: "text", delta: turn.text };
    } else if (turn.text)
      history.push({ kind: "message", role: "assistant", content: turn.text });
    if (!turn.calls.length) {
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
        run_command: "运行命令",
      };
      const activity: AgentActivity = {
        id: randomUUID(),
        requestId,
        tool: call.name,
        status: "running",
        title: titles[call.name],
        startedAt: Date.now(),
        input: call.input,
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
      const category =
        call.name === "web_search" || call.name === "fetch_url" || browserTool
          ? "network"
          : call.name === "delete_path"
            ? "deletePaths"
            : call.name === "start_process" || call.name === "stop_process"
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
        activity.output = "只读模式已阻止此操作";
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
        const allowed = await new Promise<boolean>((resolve) => {
          approvals.set(`${requestId}:${activity.id}`, resolve);
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        });
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
      try {
        const result = await execute(
          root,
          requestId,
          browserSessionId,
          activity.id,
          call,
          signal,
        );
        const failed = result.exitCode !== undefined && result.exitCode !== 0;
        Object.assign(activity, result, {
          status: failed ? "failed" : "success",
          completedAt: Date.now(),
          errorSummary: failed
            ? failureSummary(call, result.output, result.exitCode)
            : undefined,
        });
      } catch (error) {
        activity.status = "failed";
        activity.completedAt = Date.now();
        activity.output =
          error instanceof Error ? error.message : String(error);
        activity.errorSummary = failureSummary(call, activity.output);
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
          `${activity.title}${activity.status === "success" ? "完成" : "未完成"}`,
        data: {
          output: activity.output,
          diff: activity.diff,
          path: activity.path,
          command: activity.command,
          additions: activity.additions,
          deletions: activity.deletions,
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
    if (stalledRounds >= 3) {
      yield {
        type: "error",
        message: "Agent 连续 3 轮没有取得新进展，已安全暂停以避免重复执行",
      };
      return;
    }
  }
}
