import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  defaultCommandIdleTimeoutMs,
  defaultCommandTimeoutMs,
  runSpawnedCommand,
  terminateChildProcess,
} from "./process-command";
import {
  registerManagedProcess,
  terminateAllManagedProcesses,
  terminateManagedProcess,
  unregisterManagedProcess,
} from "./process-registry";
import { apiKeyCooldownPool } from "./api-key-cooldown";
import {
  STALL_PAUSE_ROUNDS,
  stallAction,
} from "./agent-stall-policy";
import { approvalCache } from "./approval-cache";
import { TurnDiffTracker } from "./turn-diff-tracker";
import { buildTurnSummary, type ToolCallRecord } from "./tool-call-recorder";
import { createDefaultStopHooks, type StopHookContext } from "./stop-hooks";
import { WorldStateDiffTracker, buildSegments } from "./world-state-diff";
import { turnDiffId, isSyntheticId } from "./synthetic-id";
import { normalizeHistory } from "./history-normalize";
import { loadProjectInstructions } from "./project-instructions";
import { fileHistory } from "./file-history";
import { FileReadCache, fileUnchangedNotice } from "./file-read-cache";
import { getStaleFileHint } from "./stale-file-hint";
import { runHooks, collectInjections, isBlocked, getBlockReason } from "./hook-lifecycle";
import { ConversationWriter } from "./conversation-persist";
import { partitionForDispatch, classifyTool, parallelWithLimit } from "./parallel-dispatch";
import { PlanSemanticAuth, type SemanticPermission } from "./plan-semantic-auth";
import { processLargeOutput } from "./output-spill";
import { resetToolStats, getToolStats } from "./tool-stats";
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
import {
  imageInputSupport,
  isUnsupportedImageInputError,
} from "../src/model-capabilities";
import {
  activityExecutionNarrative,
  dedupeExecutionNarrative,
  executionNarrativePreview,
  isExecutionContinuationNarrative,
  nextClosingVerificationRounds,
  nextExecutionNarrative,
  shouldFinalizeClosingVerification,
} from "../src/execution-narrative";
import {
  defaultExecutionPlan,
  extractExecutionPlan,
  fallbackExecutionPlanStep,
  sameExecutionPlan,
} from "../src/execution-plan";
import { isCasualGreeting } from "../src/intent";
import {
  permissionCategoryForCommand,
  resolvePermissionDecision,
} from "../src/permissions";
import { AgentStreamAssembler } from "./agent-stream";
import { RetryTextReconciler } from "./stream-recovery";
import {
  createConversationIsolation,
  historyFingerprint,
} from "./conversation-isolation";
import { writeLog } from "./logger";
import { networkFetch } from "./network";
import {
  assertGitHubRequestAllowed,
  githubRequestHeaders,
  githubResponseError,
  isGitHubUrl,
  isRecoverableGitHubError,
} from "./github-http";
import { resolveGitExecutable } from "./executables";
import {
  parseGitRemoteHead,
  validateGitBranchName,
  validateGitRemoteName,
} from "./git-remote-status";
import { conciseFailureOutput } from "./activity-errors";
import { powershellCommand } from "./powershell-command";
import {
  fetchWithRetry,
  isRetryableStreamError,
  readResponseText,
} from "./request-guard";
import {
  effectiveOpenAiProtocol,
  rememberChatFallback,
  shouldFallbackResponses,
} from "./protocol-fallback";
import {
  claimedGitOperations,
  claimedUnavailableGitOperations,
  isNotGitRepositoryOutput,
  missingRequestedGitOperations,
  requestedGitOperations,
  successfulGitEvidence,
  unavailableGitOperations,
} from "./git-operation-verification";
import {
  claimedCodingOperations,
  codingOperationsRequiringToolEvidence,
  compactOperationEvidenceResult,
  hasRequestedUserInputEvidence,
  hasSuccessfulToolEvidence,
  isAdvisoryOnlyRequest,
  isUnsupportedTaskCompletionClaim,
  missingRequestedCodingOperations,
  missingVerifiedCodingOperations,
  relevantVerificationRequestContent,
  reportsBlockedCodingOperations,
  reportsMissingRequiredUserInput,
  requestedCodingOperations,
  shouldRequireCodingTool,
  successfulCodingEvidence,
  type CodingOperation,
} from "./coding-operation-verification";
import {
  claimedBrowserOperations,
  missingRequestedBrowserOperations,
  reportsMissingBrowserTarget,
  requestedBrowserOperations,
  successfulBrowserEvidence,
  type BrowserOperation,
} from "./browser-operation-verification";
import { loadActiveSkillInstructions } from "./agent-skills";
import { AsyncQueue } from "./async-queue";
import { readSseJson } from "./sse-stream";
import { resolveModelCompatibility } from "./model-compatibility";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { requiredToolChoiceForProtocol } from "./tool-choice-policy";
import { toolRegistry } from "./tool-registry";
import { agentHooks } from "./agent-hooks";
import { turnSteeringQueue } from "./turn-steering";
import { providerApiEndpoint } from "./provider-url";
import { mutationChangedFromOutput } from "./mutation-evidence";
import { hasUserSuppliedVerificationCode } from "./browser-cdp";
import { applyUpdatePatch, normalizeLineEndings } from "./text-patch";
import { getProviderWithKey, updateModelCapabilities } from "./store";
import { callMcpTool, listMcpServerConfigs, listMcpTools } from "./mcp";
import {
  bindBrowserRequest,
  browserIsOpen,
  browserSessionUrl,
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
  forgetCredentialProfile,
  listCredentialProfiles,
  resolveCredentialProfile,
  saveCredentialProfile,
  selectCredential,
  type CredentialKind,
  type CredentialDescriptor,
} from "./credential-vault";
import {
  adoptSshSession,
  cleanupSshSessions,
  connectSsh,
  disconnectSsh,
  downloadSshFile,
  listSshDirectory,
  readSshFile,
  resolveSshRoot,
  runSshCommand,
  undoSshActivity,
  uploadSshFile,
  writeSshFile,
} from "./ssh";
import {
  resolveSshWorkspacePath,
  sshWorkspaceCommand,
} from "./ssh-remote-path";
import { privateKeyForSshTool } from "./ssh-tool-input";
import {
  adoptActiveSshRemote,
  connectSavedSshRemote,
  forgetSshRemoteProfile,
  listSshRemoteProfiles,
  sshRemoteState,
} from "./ssh-remote";
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
import { classifyMysqlSql, classifySqlServerSql } from "./sql-policy";
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
  collectedSubagentSummaries,
  drainSubagentMessages,
  listSubagents,
  messageSubagent,
  permissionPolicyForSubagent,
  spawnSubagent,
  stopSubagent,
  waitForSubagents,
} from "./subagents";
import {
  executorModelOverrides,
  isPlannerCoordinator,
  plannerCollaborationInstruction,
  plannerToolAllowed,
  remoteWorkspaceToolAllowed,
} from "./collaboration";
import { executorFinalizationMode } from "./agent-run-budget";
import {
  effectiveCommandExitCode,
  windowsCommandIssue,
} from "./command-guidance";

type ToolCall = {
  id: string;
  name: AgentToolName;
  input: Record<string, unknown>;
};

const SECRET_INPUT_KEY =
  /(?:password|passphrase|privateKey|sslKey|secret|token)$/i;

export function redactedToolInput(call: ToolCall) {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.input)) {
    if (call.name === "browser_type" && key === "text") {
      input[key] = value ? "[已安全隐藏]" : value;
      continue;
    }
    if (SECRET_INPUT_KEY.test(key)) {
      input[key] = value ? "[已安全隐藏]" : value;
      continue;
    }
    if (key === "uri" && typeof value === "string") {
      input[key] = value.replace(
        /^(mongodb(?:\+srv)?:\/\/)([^/@]+)@/i,
        "$1[已隐藏]@",
      );
      continue;
    }
    input[key] = value;
  }
  return input;
}
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
  changed?: boolean;
  executed?: boolean;
  mutationAttempted?: boolean;
  noChangeReported?: boolean;
  userInputRequested?: boolean;
  operationEvidence?: CodingOperation[];
  browserOperationEvidence?: BrowserOperation[];
  subagentUsage?: { input: number; output: number; cached: number };
};

async function* streamOperationProgress<T>(
  operation: (report: (output: string) => void) => Promise<T>,
): AsyncGenerator<string, T> {
  const queue = new AsyncQueue<string>();
  let result: T | undefined;
  const report = (output: string) => {
    queue.pushLatest(output);
  };
  void operation(report)
    .then((value) => {
      result = value;
      queue.close();
    })
    .catch((error) => queue.fail(error));
  for await (const output of queue) yield output;
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
  reasoningContent?: string;
  calls: ToolCall[];
  rawCalls: unknown[];
  usage: { input: number; output: number; cached: number };
  finishReason?: string;
};
type ModelTurnRuntime = {
  provider: Awaited<ReturnType<typeof getProviderWithKey>>;
  activeSkills: string;
  omitImageInputs?: boolean;
  keyIndex?: number;
  triedKeyIndexes?: number[];
};
type HistoryItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      content: string;
      reasoningContent?: string;
      images?: ModelRequest["messages"][number]["images"];
    }
  | { kind: "calls"; calls: ToolCall[]; rawCalls: unknown[] }
  | { kind: "result"; callId: string; content: string };

function hasImageAttachments(history: HistoryItem[]) {
  return history.some(
    (item) => item.kind === "message" && Boolean(item.images?.length),
  );
}

function historyWithoutImages(history: HistoryItem[]): HistoryItem[] {
  return history.map((item) =>
    item.kind === "message" && item.images?.length
      ? { ...item, images: undefined }
      : item,
  );
}

function compactEvidenceCall(call: ToolCall) {
  const input: Record<string, unknown> = {};
  for (const key of [
    "command",
    "path",
    "from",
    "to",
    "kind",
    "processId",
    "operation",
    "reason",
  ]) {
    if (call.input[key] !== undefined)
      input[key] = String(call.input[key]).slice(0, 4_000);
  }
  return { id: call.id, name: call.name, input };
}

function compactRuntimeHistory(
  history: HistoryItem[],
  force = false,
  activeConnections: Iterable<string> = [],
) {
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
  const uniqueConnections = [...new Set(activeConnections)];
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

function codingEvidenceFromActivities(activities: AgentActivity[]) {
  const evidence: HistoryItem[] = [];
  for (const activity of activities) {
    evidence.push({
      kind: "calls",
      calls: [
        compactEvidenceCall({
          id: activity.id,
          name: activity.tool,
          input: {
            ...activity.input,
            command: activity.command,
            path: activity.path,
          },
        }),
      ],
      rawCalls: [],
    });
    evidence.push({
      kind: "result",
      callId: activity.id,
      content: JSON.stringify({
        success: activity.status === "success",
        data: {
          changed: activity.changed,
          executed: activity.executed,
          exitCode: activity.exitCode,
          output:
            activity.tool === "process_output" ? activity.output : undefined,
        },
      }),
    });
  }
  return [...successfulCodingEvidence(evidence)];
}

function browserEvidenceFromActivities(activities: AgentActivity[]) {
  const evidence: HistoryItem[] = [];
  for (const activity of activities) {
    evidence.push({
      kind: "calls",
      calls: [
        {
          id: activity.id,
          name: activity.tool,
          input: activity.input,
        },
      ],
      rawCalls: [],
    });
    evidence.push({
      kind: "result",
      callId: activity.id,
      content: JSON.stringify({ success: activity.status === "success" }),
    });
  }
  return [...successfulBrowserEvidence(evidence)];
}

function connectionFamily(tool: AgentToolName) {
  if (tool === "ssh_connect" || tool === "ssh_disconnect") return "ssh";
  if (tool.startsWith("mysql_")) return "mysql";
  if (tool.startsWith("sqlserver_")) return "sqlserver";
  if (tool.startsWith("mongodb_")) return "mongodb";
  return undefined;
}

function updateActiveConnectionFacts(
  active: Map<string, string>,
  call: ToolCall,
  succeeded: boolean,
) {
  if (!succeeded) return;
  const family = connectionFamily(call.name);
  if (!family) return;
  if (call.name.endsWith("disconnect")) {
    active.delete(family);
    return;
  }
  if (call.name.includes("connect"))
    active.set(family, `${call.name} ${JSON.stringify(redactedToolInput(call))}`);
}

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
type PublicPage = { url: string; contentType: string; text: string };
type CachedPublicPage = PublicPage & {
  etag: string;
  lastModified: string;
  expiresAt: number;
};
const publicPageCache = new Map<string, CachedPublicPage>();
const PUBLIC_PAGE_CACHE_TTL_MS = 60_000;
const PUBLIC_PAGE_CACHE_LIMIT = 24;

/** Module-level tracker for system prompt segment diffing (cache analytics). */
const worldStateTracker = new WorldStateDiffTracker();

/** Module-level file read cache for deduplication across turns. */
let fileReadCache = new FileReadCache();

function rememberPublicPage(key: string, page: CachedPublicPage) {
  publicPageCache.delete(key);
  publicPageCache.set(key, page);
  while (publicPageCache.size > PUBLIC_PAGE_CACHE_LIMIT) {
    const oldest = publicPageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    publicPageCache.delete(oldest);
  }
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
      const cacheKey = url.href;
      const cached = publicPageCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached;
      assertGitHubRequestAllowed(url);
      const headers = githubRequestHeaders(url, {
        "User-Agent": "Mozilla/5.0 KCode/1.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5",
      });
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      if (cached?.lastModified)
        headers.set("If-Modified-Since", cached.lastModified);
      const response = await networkFetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers,
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
      if (response.status === 304 && cached) {
        const refreshed = {
          ...cached,
          expiresAt: Date.now() + PUBLIC_PAGE_CACHE_TTL_MS,
        };
        rememberPublicPage(cacheKey, refreshed);
        return refreshed;
      }
      if (!response.ok) {
        if (isGitHubUrl(url)) throw await githubResponseError(response, url);
        throw new Error(`网页请求失败 (${response.status})`);
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 2 * 1024 * 1024) throw new Error("网页响应超过 2 MB");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 2 * 1024 * 1024)
        throw new Error("网页响应超过 2 MB");
      const page = {
        url: url.href,
        contentType: response.headers.get("content-type") || "",
        text: new TextDecoder("utf-8").decode(bytes),
        etag: response.headers.get("etag") || "",
        lastModified: response.headers.get("last-modified") || "",
        expiresAt: Date.now() + PUBLIC_PAGE_CACHE_TTL_MS,
      };
      rememberPublicPage(cacheKey, page);
      return page;
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
    const message =
      details?.message ||
      (error instanceof Error ? error.message : String(error));
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
      "Apply a Begin Patch text patch for precise file edits. Never invoke apply_patch through run_command; call this tool directly. Supports Update File, Add File, and Delete File sections. LF, CRLF, and CR files are matched automatically, and existing line endings are preserved. Use @@ lines with scope hints (e.g. '@@ functionName' or '@@ ClassName.methodName') to target specific code blocks when duplicate context lines exist in the file.",
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
    name: "git_remote_status",
    description:
      "Verify whether local HEAD is present on a remote branch using native Git. Prefer this over fetch_url or GitHub pages when checking whether a push succeeded.",
    parameters: {
      type: "object",
      properties: {
        remote: { type: "string" },
        branch: { type: "string" },
      },
      additionalProperties: false,
    },
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
    name: "report_no_change",
    description:
      "Report that the requested code or configuration change is unnecessary after successful read-only inspection. Use only when the inspected target already satisfies the request, the issue is outside the workspace, or there is no actionable target. Give a specific evidence-based reason; never use this merely because editing is difficult.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 8, maxLength: 1000 },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_user_input",
    description:
      "Record that the task cannot continue until the user supplies specific missing information or completes a required human action. Use only when the information cannot be discovered with available tools. Ask one concise question and list the exact fields/actions required; never use this to avoid executable work.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 8, maxLength: 1000 },
        fields: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 120 },
          minItems: 1,
          maxItems: 12,
        },
      },
      required: ["question", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: "get_context_remaining",
    description:
      "Query how much context window budget remains for this conversation. Returns the estimated remaining tokens. Use this to decide whether to compress output, skip verbose explanations, or request context compaction.",
    parameters: {
      type: "object",
      properties: {},
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
    name: "credential_list",
    description:
      "List locally saved credential aliases and non-sensitive connection metadata. Call this before asking the user to repeat an SSH, database, or website login that may already be saved. Credential categories are isolated and secrets are never returned.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["ssh", "mysql", "sqlserver", "mongodb", "website"],
        },
        query: {
          type: "string",
          description: "Optional alias, host, database, or website filter.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "credential_save",
    description:
      "Securely save a website account explicitly supplied by the user. Database and SSH credentials are saved by their successful connect tools instead. The password is encrypted by the operating system and is never returned. Omit name to generate a stable site/account alias.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["website"] },
        name: { type: "string" },
        url: {
          type: "string",
          description:
            "HTTP/HTTPS website address. May be omitted when that site is already open in the task browser.",
        },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["kind", "username", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "credential_forget",
    description:
      "Delete one locally saved credential from exactly one credential category. Use only when the user explicitly asks to forget it.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["ssh", "mysql", "sqlserver", "mongodb", "website"],
        },
        name: { type: "string" },
      },
      required: ["kind", "name"],
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
      "Return page text and fresh references for visible interactive elements, including iframe and accessible Shadow DOM controls. Take a new snapshot after navigation or a page-changing interaction. When human verification is present, this tool waits while the user completes it in the visible browser, then returns the verified page automatically.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_click",
    description:
      "Click an element reference from the latest browser snapshot using a trusted Chromium input event.",
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
      "Replace the value of an element from the latest browser snapshot using trusted Chromium keyboard input, including credentials explicitly provided by the user.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill_credential",
    description:
      "Fill username/password controls from a saved website credential without revealing the decrypted secret to the model. The currently open page origin must match the saved website origin. Use refs from the latest browser_snapshot.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        usernameRef: { type: "string" },
        passwordRef: { type: "string" },
      },
      required: ["credentialName", "passwordRef"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture the current browser page to a local PNG. For responsive validation, provide width and height together (for example 1280x720 desktop or 390x844 mobile). Use fullPage to capture beyond the visible viewport.",
    parameters: {
      type: "object",
      properties: {
        width: { type: "number", minimum: 320, maximum: 2560 },
        height: { type: "number", minimum: 320, maximum: 2000 },
        mobile: { type: "boolean" },
        fullPage: { type: "boolean" },
      },
      additionalProperties: false,
    },
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
      "Connect this task to SSH. To reuse a local credential, pass credentialName alone after credential_list. For a new connection, pass host/username plus password or private key and optionally name; after a successful connection it is stored with operating-system encryption by default. Never invent a credential alias. Set remember=false only when the user requests a temporary connection.",
    parameters: {
      type: "object",
      properties: {
        credentialName: {
          type: "string",
          description: "Existing saved SSH alias, id, host, or user@host.",
        },
        name: {
          type: "string",
          description: "Alias used when saving a new successful connection.",
        },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        privateKeyPath: {
          type: "string",
          description:
            "Absolute local private-key path explicitly supplied by the user.",
        },
        passphrase: { type: "string" },
        remember: {
          type: "boolean",
          description:
            "Store credentials with operating-system encryption for future reconnects. Defaults to true.",
        },
        rootPath: {
          type: "string",
          description: "Remote project directory to open in the editor.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ssh_set_workspace",
    description:
      "Set or change the editable project root for the SSH server already connected to this task. Call this when the project directory becomes known after ssh_connect.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
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
          description:
            "Optional timeout in milliseconds. Defaults to 300000 for build/test/install commands and 180000 otherwise.",
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
      "Connect directly to MySQL. Pass credentialName to reuse an encrypted local MySQL profile, or pass new host/username/password fields and optional name; a successful new connection is remembered by default. MySQL profiles never resolve as SSH or other credential types.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
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
      additionalProperties: false,
    },
  },
  {
    name: "mysql_connect_via_ssh",
    description:
      "Connect to MySQL through SSH. credentialName selects only a saved MySQL profile; sshCredentialName independently selects a saved SSH profile. New database details are remembered after success unless remember=false. If no SSH fields/alias are supplied, reuse this task's active SSH session.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
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
      "Connect directly to Microsoft SQL Server using either an encrypted local credentialName or new connection fields. A successful new connection is remembered by default under name or a generated endpoint alias.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
        host: { type: "string" },
        port: { type: "number", minimum: 1, maximum: 65535 },
        username: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
        encrypt: { type: "boolean" },
        trustServerCertificate: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sqlserver_connect_via_ssh",
    description:
      "Connect to SQL Server through SSH. credentialName and sshCredentialName resolve from separate SQL Server and SSH categories. New database details are remembered after success unless remember=false.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
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
      "Connect directly to MongoDB using an encrypted local credentialName or new URI/host credentials. A successful new connection is remembered by default. Saved URI secrets are never shown in activity details.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
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
      additionalProperties: false,
    },
  },
  {
    name: "mongodb_connect_via_ssh",
    description:
      "Connect to MongoDB through SSH. credentialName and sshCredentialName resolve from separate MongoDB and SSH categories. New database details are remembered after success unless remember=false.",
    parameters: {
      type: "object",
      properties: {
        credentialName: { type: "string" },
        sshCredentialName: { type: "string" },
        name: { type: "string" },
        remember: { type: "boolean" },
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
      "Start a background subagent for a self-contained task that can run independently. In planner-executor collaboration, role executor uses the task's configured execution model; otherwise subagents inherit the current model. Workspace and permissions are inherited. Prefer separate files or research areas to avoid edit conflicts. Returns an agent id immediately.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        name: { type: "string" },
        role: { type: "string", enum: ["executor"] },
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
      "Wait for selected direct subagents, or all direct subagents when agentIds is omitted. The wait is bounded; stalled children are stopped and returned with partial results instead of hanging indefinitely. Returns final text, tool summaries, usage, and file changes.",
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
    name: "mcp_list_tools",
    description:
      "List the tools exposed by a configured MCP server. Use this before calling an external MCP tool so you know its exact name and input schema.",
    parameters: {
      type: "object",
      properties: { server: { type: "string" } },
      required: ["server"],
      additionalProperties: false,
    },
  },
  {
    name: "mcp_call_tool",
    description:
      "Call a tool on a configured Model Context Protocol (MCP) server. The server must be enabled in KCode settings; arguments must match the schema returned by mcp_list_tools.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a Windows PowerShell 5.1 command in the workspace. This is not Bash: do not use <<EOF heredocs or &&/|| chains. Prefer browser tools for page interaction, responsive screenshots, and DOM inspection; do not launch Chrome/Edge from this tool. Use start_process for background services.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: {
          type: "number",
          minimum: 1_000,
          maximum: 600_000,
          description:
            "Optional timeout in milliseconds. Defaults to 300000 for build/test/install commands and 120000 otherwise.",
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
  const removedProcessIds: string[] = [];
  for (const [id, backgroundProcess] of backgroundProcesses) {
    if (requests.has(backgroundProcess.requestId)) {
      terminateChildProcess(backgroundProcess.child);
      backgroundProcesses.delete(id);
      removedProcessIds.push(id);
    }
  }
  await Promise.allSettled(removedProcessIds.map(unregisterManagedProcess));
  const allRequestIds = [...requests];
  cleanupBrowsers(allRequestIds);
  cleanupMysqlSessions(allRequestIds);
  cleanupSqlServerSessions(allRequestIds);
  cleanupMongoSessions(allRequestIds);
  cleanupSshSessions(allRequestIds, activityIds);
  await subagentCleanup.settle();
}

export async function cleanupAllBackgroundProcesses() {
  for (const backgroundProcess of backgroundProcesses.values())
    terminateChildProcess(backgroundProcess.child);
  backgroundProcesses.clear();
  await terminateAllManagedProcesses();
}
export async function stopBackgroundProcessById(id: string) {
  const backgroundProcess = backgroundProcesses.get(id);
  if (backgroundProcess) {
    terminateChildProcess(backgroundProcess.child);
    backgroundProcesses.delete(id);
  }
  await terminateManagedProcess(id);
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

/**
 * Resolve an approval and optionally cache it for future auto-approval.
 * @param scope - 'once' (no cache), 'session' (memory), 'permanent' (persisted)
 * @param command - The command string to cache a rule for
 * @param category - Permission category
 * @param workspace - Workspace path for scoping permanent rules
 */
export function resolveApprovalWithScope(
  requestId: string,
  activityId: string,
  allowed: boolean,
  scope: "once" | "session" | "permanent",
  command?: string,
  category?: string,
  workspace?: string,
) {
  // Cache the approval if scope is session or permanent
  if (allowed && scope !== "once" && command) {
    approvalCache.approve(
      command,
      scope,
      category ?? "runCommands",
      workspace,
    );
  }
  // Resolve the pending approval
  resolveApproval(requestId, activityId, allowed);
}

export function steerAgent(requestId: string, content: string) {
  turnSteeringQueue.push(requestId, content);
}

export function clearAgentSteering(requestId: string) {
  turnSteeringQueue.clear(requestId);
}

export function clearAgentToolTraces(requestId: string) {
  toolRegistry.clearRequest(requestId);
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
    /网页读取超时|任务已取消|网页请求失败|GitHub/.test(output)
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
  if (call.name === "ssh_run") {
    const script = String(call.input.command || "");
    return !(
      /\b(?:git|gh)\b/i.test(script) && isNotGitRepositoryOutput(output)
    );
  }
  if (call.name !== "run_command") return true;
  const script = String(call.input.command || "");
  if (/\*\*\* Begin Patch|\bapply_patch\b/i.test(script)) return true;
  if (/命令执行超时|命令已取消|没有新输出，已判定卡住/.test(output))
    return true;
  if (
    /not recognized|CommandNotFoundException|找不到|无法将.*识别为/i.test(
      output,
    )
  )
    return true;
  return false;
}

function isSchemaMutationSql(sql: string) {
  return /^\s*(?:create|alter|drop|truncate|rename|grant|revoke)\b/i.test(sql);
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

type ToolCredentialKind = CredentialKind | "ssh";
type PublicToolCredential = Omit<CredentialDescriptor, "kind"> & {
  kind: ToolCredentialKind;
};

const credentialKindLabels: Record<ToolCredentialKind, string> = {
  ssh: "SSH",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
  website: "网站",
};

function parsedCredentialKind(value: unknown): ToolCredentialKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const kind = String(value) as ToolCredentialKind;
  if (!(kind in credentialKindLabels)) throw new Error("不支持的凭据类型。");
  return kind;
}

function publicSshCredential(
  profile: Awaited<ReturnType<typeof listSshRemoteProfiles>>[number],
): PublicToolCredential {
  return {
    id: profile.id,
    kind: "ssh",
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.rootPath,
    createdAt: 0,
    updatedAt: 0,
  };
}

function credentialMatchesQuery(item: PublicToolCredential, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    item.name,
    item.host,
    item.username,
    item.database,
    item.url,
    item.sshCredentialName,
  ].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
}

async function listedCredentials(
  kind?: ToolCredentialKind,
  query = "",
): Promise<PublicToolCredential[]> {
  const databaseCredentials =
    kind === "ssh"
      ? []
      : await listCredentialProfiles(kind as CredentialKind | undefined, query);
  const sshCredentials =
    kind && kind !== "ssh"
      ? []
      : (await listSshRemoteProfiles())
          .map(publicSshCredential)
          .filter((item) => credentialMatchesQuery(item, query));
  return [...sshCredentials, ...databaseCredentials].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}

async function savedSshCredential(selector: string) {
  const profiles = await listSshRemoteProfiles();
  return selectCredential(profiles, selector, "SSH ");
}

async function databaseCredentialInput(
  kind: Exclude<CredentialKind, "website">,
  rawInput: Record<string, unknown>,
) {
  const selector = String(rawInput.credentialName || "").trim();
  if (!selector)
    return {
      source: undefined,
      input: rawInput,
    };
  const source = await resolveCredentialProfile(kind, selector);
  return {
    source: source.descriptor,
    input: source.payload,
  };
}

function publicCredentialReference(descriptor?: CredentialDescriptor) {
  return descriptor
    ? {
        kind: descriptor.kind,
        name: descriptor.name,
        stored: true,
      }
    : undefined;
}

function publicSshCredentialReference(
  profile?: Awaited<ReturnType<typeof sshRemoteState>>["profile"],
) {
  return profile
    ? {
        kind: "ssh" as const,
        name: profile.name,
        stored: profile.remembered,
      }
    : undefined;
}

type PreparedDatabaseSsh = {
  sessionId: string;
  temporary: boolean;
  credentialName?: string;
};

async function prepareDatabaseSsh(
  taskId: string,
  requestId: string,
  activityId: string,
  input: Record<string, unknown>,
  linkedCredentialName: string | undefined,
  signal: AbortSignal,
): Promise<PreparedDatabaseSsh> {
  const explicitCredentialName = String(
    input.sshCredentialName || "",
  ).trim();
  if (explicitCredentialName && input.sshHost)
    throw new Error("SSH 凭据别名与新的 SSH 连接信息不能同时提供。");
  const requestedCredentialName =
    explicitCredentialName ||
    (input.sshHost ? "" : String(linkedCredentialName || "").trim());
  if (requestedCredentialName) {
    const profile = await savedSshCredential(requestedCredentialName);
    await connectSavedSshRemote(taskId, profile.id);
    return {
      sessionId: taskId,
      temporary: false,
      credentialName: profile.name,
    };
  }
  if (!input.sshHost) {
    const state = await sshRemoteState(taskId);
    return {
      sessionId: taskId,
      temporary: false,
      credentialName: state.connected ? state.profile?.name : undefined,
    };
  }
  const sessionId = `${taskId}:pending:${activityId}`;
  await connectSsh(
    sessionId,
    requestId,
    {
      host: String(input.sshHost),
      port: Number(input.sshPort) || 22,
      username: String(input.sshUsername || ""),
      password:
        typeof input.sshPassword === "string"
          ? input.sshPassword
          : undefined,
      privateKey:
        typeof input.sshPrivateKey === "string"
          ? input.sshPrivateKey
          : undefined,
      passphrase:
        typeof input.sshPassphrase === "string"
          ? input.sshPassphrase
          : undefined,
      rememberForRemoteWorkspace: input.remember !== false,
    },
    signal,
  );
  return { sessionId, temporary: true };
}

async function rememberedSshNameForDatabase(
  taskId: string,
  preferredName: string | undefined,
  remember: boolean,
) {
  const state = await sshRemoteState(taskId);
  if (state.profile) return state.profile.name;
  if (!remember) return preferredName;
  const adopted = await adoptActiveSshRemote(taskId, "~", preferredName);
  return adopted.profile?.remembered ? adopted.profile.name : undefined;
}

async function rememberDatabaseCredential(
  kind: Exclude<CredentialKind, "website">,
  callInput: Record<string, unknown>,
  connectionInput: MysqlConnectInput | SqlServerConnectInput | MongoConnectInput,
  result: Record<string, unknown>,
  viaSsh: boolean,
  source?: CredentialDescriptor,
  sshCredentialName?: string,
) {
  if (source || callInput.remember === false)
    return { credential: source };
  try {
    return {
      credential: await saveCredentialProfile({
        kind,
        name:
          typeof callInput.name === "string"
            ? callInput.name.trim()
            : undefined,
        host: String(result.host || connectionInput.host || ""),
        port: Number(result.port || connectionInput.port || 0) || undefined,
        username: String(connectionInput.username || ""),
        database: String(result.database || connectionInput.database || ""),
        viaSsh,
        sshCredentialName: sshCredentialName || undefined,
        payload: Object.fromEntries(
          Object.entries(connectionInput).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      }),
    };
  } catch (error) {
    return {
      warning: `连接已成功，但凭据未能保存：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function connectionResultOutput(
  result: Record<string, unknown>,
  persistence?: {
    credential?: CredentialDescriptor;
    warning?: string;
  },
) {
  return JSON.stringify(
    {
      ...result,
      credential: publicCredentialReference(persistence?.credential),
      credentialWarning: persistence?.warning,
    },
    null,
    2,
  );
}

function sameWebsiteOrigin(currentUrl: string, storedUrl: string) {
  try {
    return new URL(currentUrl).origin === new URL(storedUrl).origin;
  } catch {
    return false;
  }
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

async function applyPatch(
  root: string,
  requestId: string,
  activityId: string,
  patchText: string,
): Promise<ToolResult> {
  const lines = normalizeLineEndings(patchText).split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch")
    throw new Error("补丁必须以 *** Begin Patch 开始");
  const changes: {
    action: "Update" | "Add" | "Delete";
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
    changes.push({
      action: action as "Update" | "Add" | "Delete",
      file,
      before,
      after,
      existed,
    });
  }
  if (!changes.length) throw new Error("补丁中没有文件变更");
  const actualChanges = changes.filter(
    (change) =>
      change.action === "Delete" ||
      !change.existed ||
      change.before !== change.after,
  );
  for (const change of actualChanges) {
    if (change.action === "Delete") await unlink(change.file);
    else {
      await mkdir(path.dirname(change.file), { recursive: true });
      await writeFile(change.file, change.after, "utf8");
    }
    // Invalidate read cache for modified files
    fileReadCache.invalidate(change.file);
  }
  if (actualChanges.length === 1 && actualChanges[0].action !== "Delete") {
    const change = actualChanges[0];
    undoSnapshots.set(activityId, { root, requestId, ...change });
  }
  const diffs = actualChanges.map((change) => ({
    path: path.relative(root, change.file).replaceAll("\\", "/"),
    ...diffFor(
      path.relative(root, change.file).replaceAll("\\", "/"),
      change.before,
      change.after,
    ),
  }));
  return {
    output: actualChanges.length
      ? `已应用补丁，修改 ${actualChanges.length} 个文件`
      : "补丁内容与现有文件一致，未发生实际修改",
    changed: actualChanges.length > 0,
    path:
      changes.length === 1
        ? path.relative(root, changes[0].file)
        : `${changes.length} 个文件`,
    diff: diffs.map((item) => item.diff).join("\n\n"),
    additions: diffs.reduce((sum, item) => sum + item.additions, 0),
    deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
    fileChanges: diffs,
    undoable:
      actualChanges.length === 1 && actualChanges[0].action !== "Delete",
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
  const resolveRemoteToolPath = (value: unknown, fallback = "") => {
    const raw = String(value || fallback);
    if (!request.remoteWorkspace || !raw) return raw;
    return resolveSshWorkspacePath(request.remoteWorkspace.rootPath, raw);
  };
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
        return `===== ${path.relative(root, file)} =====\n${normalizeLineEndings(content).slice(0, 40_000)}`;
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
    const normalizedContent = normalizeLineEndings(content);
    const relativePath = path.relative(root, file);

    // File read deduplication: skip re-sending unchanged content
    const start = Math.max(1, Number(call.input.startLine) || 1),
      end = Math.min(
        normalizedContent.split("\n").length,
        Number(call.input.endLine) || start + 399,
      );
    const isFullRead = start === 1 && end >= normalizedContent.split("\n").length;
    if (isFullRead && fileReadCache.check(file, normalizedContent)) {
      return {
        output: `[文件未变化] ${relativePath} 内容与上次读取完全相同，无需重复展示。`,
        path: relativePath,
      };
    }
    if (isFullRead) {
      fileReadCache.record(file, normalizedContent);
    }

    return {
      output: normalizedContent
        .split("\n")
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n")
        .slice(0, 80_000),
      path: relativePath,
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
    const changed = !existed || before !== content;
    if (changed) {
      await writeFile(file, content, "utf8");
      fileReadCache.invalidate(file); // Invalidate cached read after write
      undoSnapshots.set(activityId, {
        root,
        requestId,
        file,
        before,
        after: content,
        existed,
      });
    }
    return {
      output: changed
        ? `已写入 ${Buffer.byteLength(content)} 字节`
        : "文件内容一致，未发生实际修改",
      changed,
      path: path.relative(root, file),
      undoable: changed,
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
    let existed = false;
    try {
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error("目标路径已存在且不是目录");
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true });
    return {
      path: path.relative(root, directory),
      output: existed ? "目录已存在，未发生变更" : "目录已创建",
      changed: !existed,
    };
  }
  if (call.name === "move_path") {
    const from = workspacePath(root, call.input.from),
      to = workspacePath(root, call.input.to);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    return {
      path: path.relative(root, to),
      output: `已从 ${path.relative(root, from)} 移动到 ${path.relative(root, to)}`,
      changed: true,
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
      changed: true,
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
    if (result.exitCode) {
      if (isNotGitRepositoryOutput(result.output))
        return {
          output: "当前工作区未初始化 Git：该目录不是 Git 仓库。",
          executed: true,
        };
      throw new Error(result.output || "Git 状态读取失败");
    }
    return { output: result.output || "工作区无变更" };
  }
  if (call.name === "git_remote_status") {
    const remote = validateGitRemoteName(String(call.input.remote || ""));
    let branch = String(call.input.branch || "").trim();
    if (!branch) {
      const branchResult = await command(
        root,
        resolveGitExecutable(),
        ["branch", "--show-current"],
        signal,
        10_000,
      );
      if (branchResult.exitCode)
        throw new Error(branchResult.output || "Git 当前分支读取失败");
      branch = branchResult.output.trim();
      if (!branch)
        throw new Error("当前处于 detached HEAD，请明确指定要校验的远端分支");
    }
    branch = validateGitBranchName(branch);
    const localResult = await command(
      root,
      resolveGitExecutable(),
      ["rev-parse", "HEAD"],
      signal,
      10_000,
    );
    if (localResult.exitCode)
      throw new Error(localResult.output || "Git 本地提交读取失败");
    const localHead = parseGitRemoteHead(localResult.output);
    const remoteResult = await command(
      root,
      resolveGitExecutable(),
      ["ls-remote", "--exit-code", "--refs", remote, `refs/heads/${branch}`],
      signal,
      30_000,
    );
    if (remoteResult.exitCode)
      throw new Error(
        remoteResult.output || `远端 ${remote} 未找到分支 ${branch}`,
      );
    const remoteHead = parseGitRemoteHead(remoteResult.output);
    return {
      output: JSON.stringify(
        {
          remote,
          branch,
          localHead,
          remoteHead,
          synchronized: localHead === remoteHead,
        },
        null,
        2,
      ),
      executed: true,
    };
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
      {
        cwd: root,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      },
    );
    const backgroundProcess = { root, requestId, child, output: "" } as {
      root: string;
      requestId: string;
      child: ReturnType<typeof spawn>;
      output: string;
      exitCode?: number;
    };
    const append = (chunk: Buffer) => {
      backgroundProcess.output = (
        backgroundProcess.output + new TextDecoder("utf-8").decode(chunk)
      ).slice(-100_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      backgroundProcess.exitCode = code ?? -1;
      void unregisterManagedProcess(id);
    });
    child.on("error", (error) => {
      backgroundProcess.exitCode = -1;
      backgroundProcess.output =
        `${backgroundProcess.output}\n${error.message}`.trim();
      void unregisterManagedProcess(id);
    });
    if (!child.pid) {
      terminateChildProcess(child);
      throw new Error("后台进程启动失败：未获得进程 ID");
    }
    try {
      await registerManagedProcess({
        id,
        pid: child.pid,
        processGroupId: process.platform === "win32" ? undefined : child.pid,
        requestId,
        workspacePath: root,
        startedAt: Date.now(),
      });
    } catch (error) {
      terminateChildProcess(child);
      throw new Error(
        `后台进程登记失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    backgroundProcesses.set(id, backgroundProcess);
    return {
      command: script,
      output: `后台进程已创建，需读取进程输出确认运行状态\nprocessId: ${id}`,
      executed: true,
    };
  }
  if (call.name === "process_output") {
    const id = String(call.input.processId || ""),
      process = backgroundProcesses.get(id);
    if (!process || process.root !== root)
      throw new Error("后台进程不存在或不属于当前工作区");
    return {
      output: `${process.exitCode === undefined ? "状态: 运行中" : `状态: 已退出 (${process.exitCode})`}\n${process.output || "暂无输出"}`,
      exitCode: process.exitCode === undefined ? undefined : process.exitCode,
      executed: true,
    };
  }
  if (call.name === "stop_process") {
    const id = String(call.input.processId || ""),
      process = backgroundProcesses.get(id);
    if (!process || process.root !== root)
      throw new Error("后台进程不存在或不属于当前工作区");
    terminateChildProcess(process.child);
    backgroundProcesses.delete(id);
    await unregisterManagedProcess(id);
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
  if (call.name === "credential_list") {
    const kind = parsedCredentialKind(call.input.kind);
    if (!kind) throw new Error("缺少凭据类型。");
    const query = String(call.input.query || "").trim();
    const credentials = await listedCredentials(kind, query);
    return {
      output: JSON.stringify(
        {
          credentials: credentials.map(
            ({ createdAt: _createdAt, updatedAt: _updatedAt, ...item }) => item,
          ),
          count: credentials.length,
          secretsReturned: false,
        },
        null,
        2,
      ),
    };
  }
  if (call.name === "credential_save") {
    if (call.input.kind !== "website")
      throw new Error("数据库和 SSH 凭据必须在连接成功后由连接工具保存。");
    const url =
      String(call.input.url || "").trim() || browserSessionUrl(browserSessionId);
    const username = String(call.input.username || "").trim();
    const password = String(call.input.password || "");
    if (!username || !password) throw new Error("缺少网站账号或密码。");
    const credential = await saveCredentialProfile({
      kind: "website",
      name: String(call.input.name || "").trim(),
      url,
      username,
      payload: { username, password },
    });
    return {
      output: JSON.stringify(
        {
          saved: true,
          credential: publicCredentialReference(credential),
          url: credential.url,
          username: credential.username,
        },
        null,
        2,
      ),
    };
  }
  if (call.name === "credential_forget") {
    const kind = parsedCredentialKind(call.input.kind);
    if (!kind) throw new Error("缺少凭据类型。");
    const selector = String(call.input.name || "").trim();
    if (kind === "ssh") {
      const profile = await savedSshCredential(selector);
      await forgetSshRemoteProfile(profile.id);
      return {
        output: JSON.stringify(
          { deleted: true, kind, name: profile.name },
          null,
          2,
        ),
      };
    }
    const profile = await forgetCredentialProfile(kind, selector);
    return {
      output: JSON.stringify(
        { deleted: true, kind, name: profile.name },
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
      output: JSON.stringify(
        await snapshotBrowser(browserSessionId, {
          signal,
          onProgress,
          waitForVerification: !hasUserSuppliedVerificationCode(
            request.messages,
          ),
        }),
        null,
        2,
      ),
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
  if (call.name === "browser_fill_credential") {
    const saved = await resolveCredentialProfile(
      "website",
      String(call.input.credentialName || ""),
    );
    const currentUrl = browserSessionUrl(browserSessionId);
    if (!saved.descriptor.url || !sameWebsiteOrigin(currentUrl, saved.descriptor.url))
      throw new Error(
        `当前网页与凭据“${saved.descriptor.name}”保存的网站不一致，已拒绝填充。`,
      );
    const username = String(saved.payload.username || "");
    const password = String(saved.payload.password || "");
    if (!username || !password)
      throw new Error(`网站凭据“${saved.descriptor.name}”缺少账号或密码。`);
    const filled: string[] = [];
    const usernameRef = String(call.input.usernameRef || "").trim();
    const passwordRef = String(call.input.passwordRef || "").trim();
    if (usernameRef) {
      await typeBrowser(browserSessionId, usernameRef, username);
      filled.push("username");
    }
    if (!passwordRef) throw new Error("缺少密码输入框引用。");
    await typeBrowser(browserSessionId, passwordRef, password);
    filled.push("password");
    return {
      output: JSON.stringify(
        {
          filled,
          credentialName: saved.descriptor.name,
          origin: saved.descriptor.url,
          secretsReturned: false,
        },
        null,
        2,
      ),
      executed: true,
      browserOperationEvidence: ["type"],
    };
  }
  if (call.name === "browser_screenshot") {
    const result = await screenshotBrowser(browserSessionId, {
      width:
        call.input.width === undefined ? undefined : Number(call.input.width),
      height:
        call.input.height === undefined ? undefined : Number(call.input.height),
      mobile:
        typeof call.input.mobile === "boolean" ? call.input.mobile : undefined,
      fullPage: call.input.fullPage === true,
    });
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
    const credentialName = String(call.input.credentialName || "").trim();
    if (credentialName) {
      const saved = await savedSshCredential(credentialName);
      let state = await connectSavedSshRemote(browserSessionId, saved.id);
      const requestedRootPath = String(call.input.rootPath || "").trim();
      if (requestedRootPath && requestedRootPath !== state.profile?.rootPath)
        state = await adoptActiveSshRemote(
          browserSessionId,
          requestedRootPath,
          saved.name,
        );
      const profile = state.profile;
      if (!profile) throw new Error(`SSH 凭据“${saved.name}”连接后状态丢失。`);
      return {
        output: JSON.stringify(
          {
            connected: state.connected,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            rootPath: profile.rootPath,
            credential: publicSshCredentialReference(profile),
          },
          null,
          2,
        ),
        path: profile.rootPath,
      };
    }
    const privateKey = await privateKeyForSshTool(call.input, request.messages);
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
        privateKey,
        passphrase:
          typeof call.input.passphrase === "string"
            ? call.input.passphrase
            : undefined,
        rememberForRemoteWorkspace: call.input.remember !== false,
      },
      signal,
    );
    const requestedRootPath = String(call.input.rootPath || "~");
    let rootPath: string;
    let rootPathWarning: string | undefined;
    try {
      rootPath = await resolveSshRoot(
        browserSessionId,
        requestId,
        requestedRootPath,
        signal,
      );
    } catch (error) {
      if (requestedRootPath === "~") throw error;
      rootPathWarning = `无法打开指定目录 ${requestedRootPath}：${error instanceof Error ? error.message : String(error)}`;
      rootPath = await resolveSshRoot(browserSessionId, requestId, "~", signal);
    }
    const state = await adoptActiveSshRemote(
      browserSessionId,
      rootPath,
      String(call.input.name || "").trim() || undefined,
    );
    return {
      output: JSON.stringify(
        {
          ...result,
          rootPath,
          rootPathWarning,
          credential: publicSshCredentialReference(state.profile),
        },
        null,
        2,
      ),
      path: rootPath,
    };
  }
  if (call.name === "ssh_set_workspace") {
    const rootPath = await resolveSshRoot(
      browserSessionId,
      requestId,
      String(call.input.path || ""),
      signal,
    );
    return {
      output: JSON.stringify({ connected: true, rootPath }, null, 2),
      path: rootPath,
    };
  }
  if (call.name === "ssh_run") {
    const requestedCommand = String(call.input.command || "");
    const remoteCommand = request.remoteWorkspace
      ? sshWorkspaceCommand(request.remoteWorkspace.rootPath, requestedCommand)
      : requestedCommand;
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
          Math.max(
            1_000,
            Number(call.input.timeoutMs) ||
              Math.max(180_000, defaultCommandTimeoutMs(remoteCommand)),
          ),
        ),
        onOutput: onProgress,
      },
    );
    return { ...result, command: remoteCommand, executed: true };
  }
  if (call.name === "ssh_list_directory") {
    const requestedPath = resolveRemoteToolPath(call.input.path, ".");
    return {
      path: requestedPath,
      output: JSON.stringify(
        await listSshDirectory(
          browserSessionId,
          requestId,
          requestedPath,
          signal,
        ),
        null,
        2,
      ),
    };
  }
  if (call.name === "ssh_read_file") {
    const requestedPath = resolveRemoteToolPath(call.input.path);
    return {
      path: requestedPath,
      output: await readSshFile(
        browserSessionId,
        requestId,
        requestedPath,
        signal,
      ),
    };
  }
  if (call.name === "ssh_write_file") {
    const requestedPath = resolveRemoteToolPath(call.input.path);
    const result = await writeSshFile(
      browserSessionId,
      requestId,
      activityId,
      requestedPath,
      String(call.input.content ?? ""),
      signal,
    );
    return {
      path: requestedPath,
      output: `已原子写入远程文件，共 ${result.bytes} 字节`,
      changed: result.before !== result.after,
      undoable: true,
      ...diffFor(requestedPath, result.before, result.after),
    };
  }
  if (call.name === "ssh_upload_file") {
    const localPath = path.resolve(String(call.input.localPath || ""));
    const remotePath = resolveRemoteToolPath(call.input.remotePath);
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
      changed: true,
    };
  }
  if (call.name === "ssh_download_file") {
    const remotePath = resolveRemoteToolPath(call.input.remotePath);
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
      changed: true,
    };
  }
  if (call.name === "ssh_disconnect")
    return {
      output: disconnectSsh(browserSessionId)
        ? "SSH 连接已断开"
        : "当前任务没有活动的 SSH 连接",
    };
  if (call.name === "mysql_connect") {
    const credential = await databaseCredentialInput("mysql", call.input);
    if (credential.source?.viaSsh)
      throw new Error(
        `MySQL 凭据“${credential.source.name}”需要通过 SSH 连接，请使用 MySQL SSH 连接工具。`,
      );
    const connectionInput = mysqlConnectInput(credential.input);
    const result = await connectMysql(
      browserSessionId,
      requestId,
      connectionInput,
      false,
      signal,
    );
    const remembered = await rememberDatabaseCredential(
      "mysql",
      call.input,
      connectionInput,
      result,
      false,
      credential.source,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "mysql_connect_via_ssh") {
    const credential = await databaseCredentialInput("mysql", call.input);
    const preparedSsh = await prepareDatabaseSsh(
      browserSessionId,
      requestId,
      activityId,
      call.input,
      credential.source?.sshCredentialName,
      signal,
    );
    const connectionInput = mysqlConnectInput(
      credential.input,
      "127.0.0.1",
    );
    let result;
    try {
      result = await connectMysql(
        preparedSsh.sessionId,
        requestId,
        connectionInput,
        true,
        signal,
      );
      if (preparedSsh.temporary) {
        adoptMysqlSession(preparedSsh.sessionId, browserSessionId);
        adoptSshSession(preparedSsh.sessionId, browserSessionId);
      }
    } catch (error) {
      if (preparedSsh.temporary) {
        await disconnectMysql(preparedSsh.sessionId);
        disconnectSsh(preparedSsh.sessionId);
      }
      throw error;
    }
    const sshCredentialName = await rememberedSshNameForDatabase(
      browserSessionId,
      preparedSsh.credentialName,
      call.input.remember !== false,
    );
    const remembered = await rememberDatabaseCredential(
      "mysql",
      call.input,
      connectionInput,
      result,
      true,
      credential.source,
      sshCredentialName,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "mysql_query") {
    const sql = String(call.input.sql || "");
    const values = Array.isArray(call.input.values) ? call.input.values : [];
    const risk = classifyMysqlSql(sql);
    const output = await queryMysql(
      browserSessionId,
      requestId,
      sql,
      values,
      signal,
    );
    return {
      command: sql,
      output,
      executed: true,
      changed:
        risk === "read"
          ? false
          : isSchemaMutationSql(sql) || mutationChangedFromOutput(output),
      mutationAttempted: risk !== "read",
    };
  }
  if (call.name === "mysql_disconnect")
    return {
      output: (await disconnectMysql(browserSessionId))
        ? "MySQL 连接已关闭"
        : "当前任务没有活动的 MySQL 连接",
    };
  if (call.name === "sqlserver_connect") {
    const credential = await databaseCredentialInput("sqlserver", call.input);
    if (credential.source?.viaSsh)
      throw new Error(
        `SQL Server 凭据“${credential.source.name}”需要通过 SSH 连接，请使用 SQL Server SSH 连接工具。`,
      );
    const connectionInput = sqlServerConnectInput(credential.input);
    const result = await connectSqlServer(
      browserSessionId,
      requestId,
      connectionInput,
      false,
      signal,
    );
    const remembered = await rememberDatabaseCredential(
      "sqlserver",
      call.input,
      connectionInput,
      result,
      false,
      credential.source,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "sqlserver_connect_via_ssh") {
    const credential = await databaseCredentialInput("sqlserver", call.input);
    const preparedSsh = await prepareDatabaseSsh(
      browserSessionId,
      requestId,
      activityId,
      call.input,
      credential.source?.sshCredentialName,
      signal,
    );
    const connectionInput = sqlServerConnectInput(
      credential.input,
      "127.0.0.1",
    );
    let result;
    try {
      result = await connectSqlServer(
        preparedSsh.sessionId,
        requestId,
        connectionInput,
        true,
        signal,
      );
      if (preparedSsh.temporary) {
        adoptSqlServerSession(preparedSsh.sessionId, browserSessionId);
        adoptSshSession(preparedSsh.sessionId, browserSessionId);
      }
    } catch (error) {
      if (preparedSsh.temporary) {
        await disconnectSqlServer(preparedSsh.sessionId);
        disconnectSsh(preparedSsh.sessionId);
      }
      throw error;
    }
    const sshCredentialName = await rememberedSshNameForDatabase(
      browserSessionId,
      preparedSsh.credentialName,
      call.input.remember !== false,
    );
    const remembered = await rememberDatabaseCredential(
      "sqlserver",
      call.input,
      connectionInput,
      result,
      true,
      credential.source,
      sshCredentialName,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "sqlserver_query") {
    const sql = String(call.input.sql || "");
    const values = Array.isArray(call.input.values) ? call.input.values : [];
    const risk = classifySqlServerSql(sql);
    const output = await querySqlServer(
      browserSessionId,
      requestId,
      sql,
      values,
      signal,
    );
    return {
      command: sql,
      output,
      executed: true,
      changed:
        risk === "read"
          ? false
          : isSchemaMutationSql(sql) || mutationChangedFromOutput(output),
      mutationAttempted: risk !== "read",
    };
  }
  if (call.name === "sqlserver_disconnect")
    return {
      output: (await disconnectSqlServer(browserSessionId))
        ? "SQL Server 连接已关闭"
        : "当前任务没有活动的 SQL Server 连接",
    };
  if (call.name === "mongodb_connect") {
    const credential = await databaseCredentialInput("mongodb", call.input);
    if (credential.source?.viaSsh)
      throw new Error(
        `MongoDB 凭据“${credential.source.name}”需要通过 SSH 连接，请使用 MongoDB SSH 连接工具。`,
      );
    const connectionInput = mongoConnectInput(credential.input);
    const result = await connectMongo(
      browserSessionId,
      requestId,
      connectionInput,
      false,
      signal,
    );
    const remembered = await rememberDatabaseCredential(
      "mongodb",
      call.input,
      connectionInput,
      result,
      false,
      credential.source,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "mongodb_connect_via_ssh") {
    const credential = await databaseCredentialInput("mongodb", call.input);
    const preparedSsh = await prepareDatabaseSsh(
      browserSessionId,
      requestId,
      activityId,
      call.input,
      credential.source?.sshCredentialName,
      signal,
    );
    const connectionInput = mongoConnectInput(
      credential.input,
      "127.0.0.1",
    );
    let result;
    try {
      result = await connectMongo(
        preparedSsh.sessionId,
        requestId,
        connectionInput,
        true,
        signal,
      );
      if (preparedSsh.temporary) {
        adoptMongoSession(preparedSsh.sessionId, browserSessionId);
        adoptSshSession(preparedSsh.sessionId, browserSessionId);
      }
    } catch (error) {
      if (preparedSsh.temporary) {
        await disconnectMongo(preparedSsh.sessionId);
        disconnectSsh(preparedSsh.sessionId);
      }
      throw error;
    }
    const sshCredentialName = await rememberedSshNameForDatabase(
      browserSessionId,
      preparedSsh.credentialName,
      call.input.remember !== false,
    );
    const remembered = await rememberDatabaseCredential(
      "mongodb",
      call.input,
      connectionInput,
      result,
      true,
      credential.source,
      sshCredentialName,
    );
    return { output: connectionResultOutput(result, remembered) };
  }
  if (call.name === "mongodb_execute") {
    const operation = String(call.input.operation || "");
    const mutationAttempted = ![
      "find",
      "aggregate",
      "countDocuments",
      "distinct",
    ].includes(operation);
    const output = await executeMongo(
      browserSessionId,
      requestId,
      call.input as any,
      signal,
    );
    return {
      output,
      executed: true,
      changed: mutationAttempted ? mutationChangedFromOutput(output) : false,
      mutationAttempted,
    };
  }
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
    const role = String(call.input.role || "").trim();
    if (role && role !== "executor") throw new Error("不支持的子 Agent 角色。");
    const executorOverride = executorModelOverrides(request);
    if (executorOverride) {
      const executorProvider = await getProviderWithKey(
        executorOverride.providerId,
      );
      if (!executorProvider.enabled) throw new Error("执行模型供应商已停用。");
      if (
        !executorProvider.models.some(
          (model) => model.modelId === executorOverride.modelId,
        )
      )
        throw new Error("执行模型已被移除或不属于所选供应商。");
    }
    const childName = executorOverride ? name || "执行 Agent" : name;
    const childModelOverride = executorOverride
      ? {
          providerId: executorOverride.providerId,
          modelId: executorOverride.modelId,
          reasoningEffort: executorOverride.reasoningEffort,
          contextWindow: executorOverride.contextWindow,
          agentRole: executorOverride.agentRole,
          collaboration: executorOverride.collaboration,
        }
      : {};
    const delegatedRequestContext = executorOverride
      ? relevantVerificationRequestContent(
          request.messages.map((message) => ({
            kind: "message" as const,
            ...message,
          })),
        ).slice(-12_000)
      : "";
    const delegatedImages = executorOverride
      ? [...request.messages]
          .reverse()
          .find((message) => message.images?.length)?.images
      : undefined;
    // Thread the most recent already-collected executor's conclusion into a
    // follow-up executor so the planner need not restate everything. Only the
    // latest collected summary is carried to keep the delegated task focused.
    const priorExecutorSummary = executorOverride
      ? collectedSubagentSummaries(requestId).at(-1)
      : undefined;
    const priorExecutorContext = priorExecutorSummary
      ? `\n\n上一执行 Agent（${priorExecutorSummary.name}）的结果摘要，供衔接参考，勿重复其已完成的工作：\n${priorExecutorSummary.transcript.slice(-4_000)}`
      : "";
    const state = spawnSubagent(
      requestId,
      childName,
      task,
      signal,
      (childRequestId, agentId, childSignal) =>
        runAgent(
          childRequestId,
          {
            ...request,
            ...childModelOverride,
            taskId: `${request.taskId || requestId}:subagent:${agentId}`,
            agentDepth: (request.agentDepth ?? 0) + 1,
            permissionPolicy: permissionPolicyForSubagent(
              request.permissionMode,
              request.permissionPolicy,
            ),
            messages: [
              {
                role: "user",
                content: `${executorOverride ? `你是协作任务的执行 Agent，当前执行模型为 ${executorOverride.displayName}。严格落实规划 Agent 给出的步骤和验收条件，使用真实工具完成修改与验证，不要只重复规划。` : "你是主 Agent 委派的子 Agent。"}请独立完成以下任务并向主 Agent 返回准确、简洁、可验证的结果。不要等待用户补充信息；遇到阻碍时说明已检查的内容和具体阻碍。避免修改其他子 Agent 可能负责的文件。${delegatedRequestContext ? `\n\n原始用户目标：\n${delegatedRequestContext}` : ""}${priorExecutorContext}\n\n委派任务：\n${task}`,
                images: delegatedImages,
              },
            ],
          },
          childSignal,
        ),
      executorOverride
        ? {
            agentRole: "executor",
            providerId: executorOverride.providerId,
            modelId: executorOverride.modelId,
            modelDisplayName: executorOverride.displayName,
            reasoningEffort: executorOverride.reasoningEffort,
          }
        : undefined,
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
    const results = await waitForSubagents(requestId, agentIds, {
      signal,
      onProgress,
    });
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
      exitCode: results.every((result) => result.status === "completed") ? 0 : 1,
      additions: childActivities.reduce(
        (sum, activity) => sum + (activity.additions ?? 0),
        0,
      ),
      deletions: childActivities.reduce(
        (sum, activity) => sum + (activity.deletions ?? 0),
        0,
      ),
      changed: childActivities.some(
        (activity) =>
          activity.status === "success" &&
          (activity.changed === true ||
            Boolean(activity.diff) ||
            Boolean(activity.additions) ||
            Boolean(activity.deletions)),
      ),
      operationEvidence: codingEvidenceFromActivities(childActivities),
      browserOperationEvidence: browserEvidenceFromActivities(childActivities),
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
      operationEvidence: codingEvidenceFromActivities(activityRecords),
      browserOperationEvidence: browserEvidenceFromActivities(activityRecords),
    };
  }
  if (call.name === "report_no_change") {
    const reason = String(call.input.reason || "")
      .replace(/\s+/g, " ")
      .trim();
    if (reason.length < 8)
      throw new Error("无需修改的原因必须包含具体检查结论");
    return {
      output: `无需修改：${reason}`,
      changed: false,
      noChangeReported: true,
    };
  }
  if (call.name === "request_user_input") {
    const question = String(call.input.question || "")
      .replace(/\s+/g, " ")
      .trim();
    const fields = Array.isArray(call.input.fields)
      ? call.input.fields
          .map((field) => String(field).replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 12)
      : [];
    if (question.length < 8 || !fields.length)
      throw new Error("等待用户输入时必须说明问题并列出所需信息");
    return {
      output: `等待补充信息：${question}\n需要：${fields.join("、")}`,
      changed: false,
      userInputRequested: true,
    };
  }
  if (call.name === "mcp_list_tools") {
    const server = String(call.input.server || "").trim();
    if (!server) throw new Error("缺少 MCP 服务名称");
    const tools = await listMcpTools(server, signal);
    return {
      output: JSON.stringify(
        {
          server,
          tools,
          hint: "下一步使用 mcp_call_tool，并把工具名和 arguments 按 schema 传入。",
        },
        null,
        2,
      ),
      executed: true,
    };
  }
  if (call.name === "mcp_call_tool") {
    const server = String(call.input.server || "").trim();
    const tool = String(call.input.tool || "").trim();
    if (!server || !tool) throw new Error("MCP 调用缺少 server 或 tool");
    const result = await callMcpTool(
      server,
      tool,
      call.input.arguments && typeof call.input.arguments === "object"
        ? (call.input.arguments as Record<string, unknown>)
        : {},
      signal,
      onProgress,
    );
    return {
      output: result.isError
        ? `MCP 工具返回错误：${result.output}`
        : result.output,
      executed: true,
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
        executed: false,
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
      defaultCommandTimeoutMs(diagnostic.command!),
    );
    return {
      command: diagnostic.command,
      output: result.output || "诊断未产生输出",
      exitCode: result.exitCode,
      executed: true,
    };
  }
  const script = String(call.input.command || "");
  if (!script) throw new Error("缺少命令");
  if (process.platform === "win32") {
    const commandIssue = windowsCommandIssue(script);
    if (commandIssue)
      return {
        output: commandIssue,
        command: script,
        executed: false,
      };
  }
  const timeoutMs = Math.min(
    600_000,
    Math.max(
      1_000,
      Number(call.input.timeoutMs) || defaultCommandTimeoutMs(script),
    ),
  );
  // Network CLIs often print nothing until they finish or hang. Package
  // installation gets a wider silence window; other network commands retain
  // the tighter guard so the UI cannot remain stuck for the full timeout.
  const idleTimeoutMs = defaultCommandIdleTimeoutMs(script, timeoutMs);
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
    exitCode: effectiveCommandExitCode(result.exitCode, result.output),
    executed: true,
  };
}

async function* sseJson(
  response: Response,
  signal: AbortSignal,
  idleTimeoutMs?: number,
  onProgress?: (message: string) => void,
): AsyncGenerator<any> {
  yield* readSseJson(response, { signal, idleTimeoutMs, onProgress });
}

async function parseStreamedTurn(
  protocol: string,
  response: Response,
  signal: AbortSignal,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
  onProgress?: (message: string) => void,
  idleTimeoutMs?: number,
  chatChunkMode: "delta" | "cumulative" | "auto" = "delta",
): Promise<Turn> {
  if (response.body) {
    const assembler = new AgentStreamAssembler(
      protocol as any,
      onText,
      onReasoning,
      { chatChunkMode },
    );
    for await (const event of sseJson(
      response,
      signal,
      idleTimeoutMs,
      onProgress,
    ))
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
  | { type: "text_reset"; replacement?: string }
  | { type: "reasoning_reset" }
  | { type: "reasoning"; delta: string }
  | { type: "progress"; message: string }
  | { type: "complete"; turn: Turn };

/**
 * Injection seam for the model turn. `runAgent` calls a `ModelStreamFn` instead
 * of `streamModelTurn` directly, so tests can drive the loop with a scripted
 * fake (no provider, no network) and the CLI/desktop share the same loop with
 * the real implementation. The default binds to `streamModelTurn` verbatim.
 */
export type ModelStreamFn = (args: {
  root: string;
  requestId: string;
  request: ModelRequest;
  history: HistoryItem[];
  signal: AbortSignal;
  toolsEnabled: boolean;
  requireToolCall: boolean;
  runtime: ModelTurnRuntime;
  attemptBudget: ModelAttemptBudget;
}) => AsyncGenerator<TurnStreamEvent>;

/** Resolves a provider+key. Default = getProviderWithKey (reads the store). */
export type ProviderResolver = (
  providerId: string,
) => Promise<Awaited<ReturnType<typeof getProviderWithKey>>>;

/** Optional dependency overrides for runAgent. All default to production impls. */
export interface RunAgentDeps {
  streamTurn?: ModelStreamFn;
  getProvider?: ProviderResolver;
}

/** Default model-turn implementation: flattens the injected args onto streamModelTurn. */
function defaultStreamTurn(args: {
  root: string;
  requestId: string;
  request: ModelRequest;
  history: HistoryItem[];
  signal: AbortSignal;
  toolsEnabled: boolean;
  requireToolCall: boolean;
  runtime: ModelTurnRuntime;
  attemptBudget: ModelAttemptBudget;
}): AsyncGenerator<TurnStreamEvent> {
  return streamModelTurn(
    args.root,
    args.requestId,
    args.request,
    args.history,
    args.signal,
    args.toolsEnabled,
    args.requireToolCall,
    args.runtime,
    args.attemptBudget,
  );
}

async function* streamModelTurn(
  root: string,
  requestId: string,
  request: ModelRequest,
  history: HistoryItem[],
  signal: AbortSignal,
  toolsEnabled: boolean,
  requireToolCall: boolean,
  runtime: ModelTurnRuntime,
  attemptBudget: ModelAttemptBudget,
): AsyncGenerator<TurnStreamEvent> {
  const queue = new AsyncQueue<TurnStreamEvent>();
  let turn: Turn | undefined;
  const reconciler = new RetryTextReconciler();
  const reasoningReconciler = new RetryTextReconciler();
  const enqueue = (event: TurnStreamEvent) => {
    queue.push(event);
  };
  const pushText = (delta: string) => {
    if (!delta) return;
    const reconciled = reconciler.push(delta);
    if (reconciled.reset) {
      // A divergent retry replaces the visible fragment atomically. Emitting a
      // bare reset followed by a text delta produces a blank React frame and a
      // conspicuous flash on long answers.
      enqueue({ type: "text_reset", replacement: reconciled.delta });
    } else if (reconciled.delta) {
      enqueue({ type: "text", delta: reconciled.delta });
    }
  };
  const completeTextAttempt = () => {
    const reconciled = reconciler.completeAttempt();
    if (reconciled.reset)
      enqueue({ type: "text_reset", replacement: reconciled.delta });
    else if (reconciled.delta)
      enqueue({ type: "text", delta: reconciled.delta });
  };
  const pushReasoning = (delta: string) => {
    if (!delta) return;
    const reconciled = reasoningReconciler.push(delta);
    if (reconciled.reset) enqueue({ type: "reasoning_reset" });
    if (reconciled.delta)
      enqueue({ type: "reasoning", delta: reconciled.delta });
  };
  const completeReasoningAttempt = () => {
    const reconciled = reasoningReconciler.completeAttempt();
    if (reconciled.reset) enqueue({ type: "reasoning_reset" });
    if (reconciled.delta)
      enqueue({ type: "reasoning", delta: reconciled.delta });
  };
  const pushProgress = (message: string) => {
    if (message) enqueue({ type: "progress", message });
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
  // Reconcile restarted streams with text already shown to the user. The same
  // request budget also covers first-byte retries and protocol fallbacks.
  const run = async () => {
    for (let attempt = 1; ; attempt += 1) {
      reconciler.beginAttempt();
      reasoningReconciler.beginAttempt();
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
          pushProgress,
          undefined,
          runtime,
          attemptBudget,
        );
        completeReasoningAttempt();
        completeTextAttempt();
        return;
      } catch (error) {
        if (
          signal.aborted ||
          attempt >= 3 ||
          !attemptBudget.canAttempt() ||
          !isRetryableStreamError(error)
        )
          throw error;
        // Keep already visible text. The next attempt is reconciled against
        // that prefix, so replayed output is suppressed without a visual reset.
        const delay =
          2_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 750);
        pushProgress(
          `上游暂时不可用，${Math.ceil(delay / 1_000)} 秒后自动重试（第 ${attempt} 次）…`,
        );
        await sleep(delay);
        if (signal.aborted) throw error;
      }
    }
  };
  void run()
    .then(() => {
      queue.close();
    })
    .catch((error) => queue.fail(error));
  for await (const event of queue) yield event;
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
  onProgress?: (message: string) => void,
  protocolOverride?: Protocol,
  runtime?: ModelTurnRuntime,
  attemptBudget?: ModelAttemptBudget,
): Promise<Turn> {
  const provider =
    runtime?.provider ?? (await getProviderWithKey(request.providerId));
  const apiKeys = provider.apiKeys?.length
    ? provider.apiKeys
    : [provider.apiKey];
  const requestedKeyIndex =
    runtime?.keyIndex ?? apiKeyCooldownPool.select(provider.id, apiKeys.length);
  const keyIndex = Math.min(
    Math.max(0, requestedKeyIndex),
    Math.max(0, apiKeys.length - 1),
  );
  const activeApiKey = apiKeys[keyIndex] || provider.apiKey;
  const triedKeyIndexes = new Set(runtime?.triedKeyIndexes ?? []);
  const nextApiKeyIndex = () => {
    triedKeyIndexes.add(keyIndex);
    return apiKeyCooldownPool.next(
      provider.id,
      apiKeys.length,
      keyIndex,
      triedKeyIndexes,
    );
  };
  if (!provider.enabled) throw new Error("当前供应商已停用");
  if (!provider.models.some((model) => model.modelId === request.modelId))
    throw new Error("模型不属于当前供应商或已被移除");
  const selectedModel = provider.models.find(
    (model) => model.modelId === request.modelId,
  )!;
  const protocol =
    protocolOverride ??
    (provider.protocol === "openai-responses" &&
    selectedModel.supportsResponses === false
      ? "openai-chat"
      : effectiveOpenAiProtocol(
          provider.id,
          provider.protocol,
          request.modelId,
        ));
  const compatibility = resolveModelCompatibility(
    provider,
    selectedModel,
    protocol,
  );
  const imageSupport = imageInputSupport(selectedModel, protocol);
  const omitImageInputs =
    runtime?.omitImageInputs === true || imageSupport === "unsupported";
  const payloadHistory = normalizeHistory(
    omitImageInputs ? historyWithoutImages(history) : history,
  ) as typeof history;
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
  const plannerCoordinator = isPlannerCoordinator(request);
  const runtimeTools = toolsEnabled
    ? tools.filter(
        (tool) =>
          !((request.agentDepth ?? 0) >= 2 && tool.name === "spawn_agent") &&
          (!request.remoteWorkspace || remoteWorkspaceToolAllowed(tool.name)) &&
          (!plannerCoordinator ||
            plannerToolAllowed(tool.name, Boolean(request.remoteWorkspace))),
      )
    : [];
  const isolation = createConversationIsolation(request.taskId, requestId);
  const latestUserRequest = relevantVerificationRequestContent(history);
  const enabledMcpServers = listMcpServerConfigs().filter(
    (server) => server.enabled,
  );
  const activeSkills = [
    runtime?.activeSkills ??
      (await loadActiveSkillInstructions(latestUserRequest)),
    plannerCollaborationInstruction(request),
    "When a task has multiple independent phases, begin with a short numbered plan (1., 2., 3. …). Before every tool-call group, write no more than two concise user-facing progress sentences explaining which plan step you are executing and why; keep this preamble under 240 characters. Never dump a full implementation monologue, speculative patch, or repeated plan into the chat. Put the structured plan in numbered steps, then call the relevant tools in the same turn. A non-final turn must include a tool call instead of only describing what you will do. After a failed tool result, briefly explain how you are adjusting the approach before the next tool call. Never claim success before a tool result confirms it.",
    enabledMcpServers.length
      ? `KCode 已启用这些 MCP 服务：${enabledMcpServers.map((server) => `${server.name}（server=${server.id}）`).join("、")}。需要使用外部扩展能力时，先用对应 server ID 调用 mcp_list_tools 获取真实 schema，再调用 mcp_call_tool；不要凭空捏造 MCP 工具结果。MCP 工具活动和错误必须如实展示给用户。`
      : "当前没有启用 MCP 扩展；不要声称调用了 MCP 工具。",
    "Past-tense claims about real workspace or external actions are checked against successful structured tool results. Do not say that a file was changed, a command ran, a test passed, a remote connection or transfer completed, a browser action happened, or a Git action completed unless the corresponding tool evidence exists in this run. Informational answers, explanations, planning, and content generation that require no real action may finish without calling a tool; do not invent an action claim merely to create evidence. If an earlier statement was wrong, retract it explicitly instead of inventing evidence.",
    "Saved credentials are local to this KCode installation and isolated by category: SSH, MySQL, SQL Server, MongoDB, and website credentials must never be substituted across categories. Before asking the user to repeat a credential, call credential_list with the exact category and the alias, host, database, or site they named. If no saved match exists, say that the local category has no such credential and request the missing connection fields once. For a saved match, pass credentialName to the matching connect tool; for SSH-tunneled databases, resolve the database credentialName and sshCredentialName independently. A successful new SSH or database connection is remembered by default unless the user explicitly requests a temporary connection. Use a user-provided name for a new credential when available; otherwise let the tool generate an endpoint alias. Use credential_save for website accounts and browser_fill_credential to fill them without exposing the password. Never invent an existing alias, put a decrypted secret in chat, send a secret to a subagent, or place one in a command when a native credential-aware tool can perform the action.",
    request.remoteWorkspace
      ? "This is a managed SSH Remote task with hybrid file access: the ssh_* tools act on the remote server, while the local file, git, and command tools act on THIS local machine. Use ssh_run for remote shell work (its shell and OS come from the remote server); run_command runs local Windows PowerShell 5.1, not Bash, and must never use <<EOF heredocs or &&/|| chains. When the user points to local files by absolute path (for example D:\\project\\... on Windows), read, edit, build, and inspect them with the local file and command tools, then use ssh_upload_file to deploy the results to the server and ssh_download_file to pull remote files down. Reuse the managed session while it is connected. If an SSH tool explicitly reports that the session was lost, call ssh_connect with credentials already supplied by the user; never ask the user to create another SSH Remote manually. Do not disconnect the managed session unless the user explicitly requests it."
      : "run_command uses Windows PowerShell 5.1, not Bash. Never use <<EOF heredocs or &&/|| chains; use a PowerShell here-string for multiline stdin and check $LASTEXITCODE explicitly when chaining native commands. Use browser_open, browser_snapshot, browser_click, browser_type, and browser_screenshot for browser work. For responsive validation, pass explicit width and height to browser_screenshot. Never launch Chrome or Edge through run_command for browsing, DOM inspection, version checks, or screenshots.",
    !request.remoteWorkspace
      ? "When connecting to a remote project, pass its project directory as rootPath to ssh_connect so KCode opens the editable SSH Remote workspace immediately. If you learn the project directory only after connecting, call ssh_set_workspace once with that directory. Do not leave the editor rooted at the server home when a more specific project root is known, and do not call ssh_disconnect after finishing unless the user explicitly asks to disconnect."
      : "",
    "Never create a Git commit, push a branch or tag, or trigger a release/build workflow unless the latest user request explicitly asks for that Git action. Business-domain phrases such as submitting an order, pushing a message, publishing content, or running a local package/build are not Git authorization. Read-only Git status or diff checks may be used only when relevant to workspace safety and must not turn into a Git task.",
    "When you create, generate, or download a local file for the user, include a clickable Markdown link to it in the final reply. For a file inside the workspace, make the href its workspace-relative path with forward slashes, for example [report.txt](output/report.txt). Use an absolute local path only for files outside the workspace. Do not present a remote-server-only path as a local file link.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const requiredToolInstruction =
    requireToolCall && runtimeTools.length
      ? "\n\n<runtime_tool_requirement>This response must include at least one native tool call. Do not return a plan, progress narration, or completion summary without calling a tool. Use request_user_input only when a specific undiscoverable input is genuinely required, and use report_no_change only after successful read-only inspection proves that no edit is needed.</runtime_tool_requirement>"
      : "";
  const remoteWorkspaceInstruction = request.remoteWorkspace
    ? `\n\n<ssh_remote_workspace>\nThis task is attached to a managed SSH Remote workspace. Try the existing session first. If an SSH tool explicitly reports that the session was lost, ssh_connect is available for recovery. When the user already supplied the host, username, password, private-key content, or an absolute private-key path, reconnect yourself immediately with those values; use privateKeyPath for a user-supplied key path and do not send the user to the SSH Remote dialog. The project source of truth is on ${request.remoteWorkspace.username}@${request.remoteWorkspace.host}:${request.remoteWorkspace.port} under ${request.remoteWorkspace.rootPath}. Pass that rootPath when reconnecting. Use ssh_list_directory, ssh_read_file, ssh_write_file, ssh_run, ssh_upload_file, and ssh_download_file for work on the remote server. Relative SSH file paths are automatically resolved under the remote root. Every ssh_run command starts in the remote root. This is a hybrid task: you ALSO have the local file, git, and command tools, which act on THIS machine. When the user references local project sources by absolute path (for example D:\\\\project\\\\... on Windows), use the local tools to read, edit, build, and inspect them, then ssh_upload_file to deploy build artifacts to the server. Note ${root} itself is only KCode metadata/cache, not the user's local project — do not treat that cache directory as the source, but do freely use the local tools on the absolute paths the user points you to.\n</ssh_remote_workspace>`
    : "";
  const system = `${isolation.boundary}\nYou are a coding agent working in ${root}. Use the provided native tools to inspect and modify the project. Each run_command invocation uses a fresh PowerShell process, so environment variable changes do not persist to later commands; combine dependent setup and execution in one command. Prefer apply_patch for precise edits and write_file for new or complete files. Never invoke apply_patch, file deletion, file moves, or directory operations through run_command when a native tool exists. File tool paths accept absolute paths, including other drives (for example D:\\B on Windows); use them to read or write files the user explicitly points to outside ${root}, and resolve relative paths against ${root}. When you mention a file in your reply, always write its full workspace-relative path (for example src/views/Gooddetail.vue, not just Gooddetail.vue) so the user can tell exactly which file it is. Use web_search for current or externally verifiable information and fetch_url to inspect primary sources; preserve source URLs in the final answer. For interactive or authenticated sites use browser_open, browser_snapshot, browser_click, and browser_type. Credentials explicitly supplied by the user may be entered directly with browser_type. Browser recording is opt-in: call browser_record_start only after an explicit user request such as 开始录制, and call browser_record_stop when the user asks to stop or generate Python. Never record ordinary browsing by default. For independent work that can run concurrently, use spawn_agent with self-contained, non-overlapping tasks, then wait_agent before giving a final answer. Use list_agents, message_agent, and stop_agent to coordinate them. Subagents normally inherit this task's model; planner-executor collaboration routes executor agents to the configured execution model. Workspace and permissions remain shared. For remote servers, call ssh_connect with credentials explicitly supplied by the user, then use ssh_run and the SSH SFTP tools. Use ssh_upload_file to send a local file to the server and ssh_download_file to fetch a remote file to a local path; these transfer binary content directly, unlike ssh_write_file which only writes inline UTF-8 text. SSH exec sessions are non-interactive and may not load shell profiles; when a remote command depends on profile-defined PATH values, invoke the appropriate login shell explicitly. SSH host keys are not verified. Credentials supplied by the user may appear in commands, tool activity details, subagent tasks, and conversation text. For databases, use mysql_connect for direct MySQL access or mysql_connect_via_ssh for an SSH tunnel, then mysql_query; use ? placeholders and values for user-provided data when practical. Public direct MySQL connections use TLS by default and you must not retry with ssl=false unless the user explicitly approves. Never attempt to solve or bypass CAPTCHA, SMS, passkey, or two-factor verification. browser_snapshot waits while the user completes human verification in the visible browser and resumes automatically afterward, so do not end the task merely to ask the user to say continue. Do not claim an action succeeded until its tool result confirms it. Before finishing, compare every action requested by the user with successful tool results. A file task is complete only after a mutating tool produced an actual change; a validation is complete only after it really ran successfully after the latest change; a background service is started only after process_output confirms it is running. When the user explicitly requested a code or configuration change and successful inspection proves that change is unnecessary, call report_no_change with the specific evidence-based reason before the final response; do not manufacture a no-op edit. If the task cannot continue because the user must supply a URL, file, credential, repository target, requirement, permission, verification code, or another specific external input that cannot be discovered with the available tools, call request_user_input once with the exact question and required fields, then ask the user for them. Never use request_user_input to avoid work that the available tools can perform. For informational or status questions, answer from successful read-only evidence without calling report_no_change. If an action could not be completed, state that explicitly instead of saying it was done.${remoteWorkspaceInstruction}${activeSkills ? `\n\n${activeSkills}` : ""}${request.recoveryContext ? `\n\n<recovery_context>${request.recoveryContext}</recovery_context>\nThis task resumed after an interruption. Treat the recovery record as prior evidence. If the latest user asks only for a conclusion, status, or summary, answer directly from that evidence without repeating tool calls. If the user asks to continue execution, verify prior side effects before repeating them and recreate only interrupted work that is still needed.` : ""}`;
  const imageInputNotice =
    omitImageInputs && hasImageAttachments(history)
      ? "\n\n当前模型不支持图片输入，历史图片附件已被省略。请只依据文字、上下文文件和工作区继续，不要假装看到了图片。"
      : "";
  const suppliedVerificationCodeNotice = hasUserSuppliedVerificationCode(
    request.messages,
  )
    ? "\n\nThe user explicitly supplied a numeric SMS, email, OTP, or 2FA code in this conversation. You may enter that supplied code with browser_type and submit it; this narrow exception is not permission to retrieve, guess, solve, or bypass any verification."
    : "";
  const projectInstructions = loadProjectInstructions(root);
  const projectInstructionsSection = projectInstructions
    ? `\n\n<project_instructions>\n${projectInstructions}\n</project_instructions>`
    : "";
  const payloadSystem = `${system}${suppliedVerificationCodeNotice}${imageInputNotice}${projectInstructionsSection}${requiredToolInstruction}`;
  // Track system prompt segment changes for cache optimization analytics
  worldStateTracker.recordRound(buildSegments([
    { name: "identity", content: isolation.boundary },
    { name: "tools", content: "tools" }, // stable — schema is constant per request
    { name: "permissions", content: request.permissionPolicy ? JSON.stringify(request.permissionPolicy) : "" },
    { name: "workspace", content: root },
    { name: "skills", content: activeSkills },
    { name: "notices", content: `${suppliedVerificationCodeNotice}${imageInputNotice}` },
  ]));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...isolation.headers,
  };
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] = activeApiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini-generate-content") {
    /* Gemini uses a query-string key. */
  } else headers.Authorization = `Bearer ${activeApiKey}`;
  let url = "",
    body: Record<string, unknown> = {};
  const requiredToolControl =
    requireToolCall && runtimeTools.length
      ? requiredToolChoiceForProtocol(protocol, {
          anthropicThinkingEnabled:
            reasoning.reasoningMode === "budget" && effort !== "auto",
        })
      : {};
  if (protocol === "openai-chat") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "chat/completions");
    const messages: unknown[] = [{ role: "system", content: payloadSystem }];
    for (const item of payloadHistory) {
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
        messages.push({
          role: item.role,
          content,
          ...(item.role === "assistant" && item.reasoningContent
            ? { reasoning_content: item.reasoningContent }
            : {}),
        });
      } else if (item.kind === "calls") {
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
          }
        : {}),
      ...requiredToolControl,
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
      reasoning_split: compatibility.splitReasoning ? true : undefined,
    };
  } else if (protocol === "openai-responses") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "responses");
    const input: unknown[] = [{ role: "developer", content: payloadSystem }];
    for (const item of payloadHistory) {
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
      ...requiredToolControl,
      reasoning:
        reasoning.reasoningMode === "effort" &&
        !["auto", "thinking"].includes(effort)
          ? { effort }
          : undefined,
    };
  } else if (protocol === "anthropic-messages") {
    url = providerApiEndpoint(provider.baseUrl, protocol, "messages");
    const messages: { role: string; content: unknown }[] = [];
    for (const item of payloadHistory) {
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
      system: payloadSystem,
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
      ...requiredToolControl,
    };
  } else {
    url = `${providerApiEndpoint(provider.baseUrl, protocol, `models/${encodeURIComponent(request.modelId)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(activeApiKey)}`;
    const contents: { role: string; parts: unknown[] }[] = [];
    for (const item of payloadHistory) {
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
        const call = [...payloadHistory]
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
      systemInstruction: { parts: [{ text: payloadSystem }] },
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
      ...requiredToolControl,
    };
  }
  // Reasoning models can spend minutes thinking before the first byte arrives,
  // especially behind a third-party proxy with a large context. Keep a shorter
  // bound for regular models while progress events make either wait observable.
  const firstByteTimeoutMs =
    reasoning.reasoningMode !== "none" ? 300_000 : 90_000;
  const serializedBody = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: serializedBody,
      },
      {
        signal,
        firstByteTimeoutMs,
        retries: 2,
        retryDelayMs: 2_000,
        maxBackoffMs: 30_000,
        onProgress,
        attemptBudget,
      },
    );
  } catch (error) {
    const retryableKeyError =
      apiKeys.length > 1 && isRetryableStreamError(error);
    if (retryableKeyError)
      apiKeyCooldownPool.markUnavailable(provider.id, keyIndex);
    const nextKeyIndex = retryableKeyError ? nextApiKeyIndex() : undefined;
    if (nextKeyIndex !== undefined && !signal.aborted) {
      onProgress?.(
        `当前 API Key 暂时不可用，自动切换备用 Key（${nextKeyIndex + 1}/${apiKeys.length}）…`,
      );
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
        onProgress,
        protocolOverride,
        {
          provider,
          activeSkills: runtime?.activeSkills ?? "",
          omitImageInputs: runtime?.omitImageInputs,
          keyIndex: nextKeyIndex,
          triedKeyIndexes: [...triedKeyIndexes],
        },
        attemptBudget,
      );
    }
    throw error;
  }
  writeLog("info", "model.response", {
    requestId: isolation.traceId,
    taskScopeId: isolation.taskScopeId,
    conversationId: isolation.conversationId,
    providerId: request.providerId,
    modelId: request.modelId,
    protocol,
    status: response.status,
    requestBytes: Buffer.byteLength(serializedBody, "utf8"),
    toolCount: runtimeTools.length,
    historyHash: historyFingerprint(payloadHistory),
    upstreamRequestId:
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined,
  });
  let responseErrorText: string | undefined;
  if (
    protocol === "openai-responses" &&
    !response.ok &&
    (response.status === 400 || response.status === 422)
  )
    responseErrorText = await readResponseText(response, signal);
  if (
    protocol === "openai-responses" &&
    shouldFallbackResponses(
      provider.baseUrl,
      response.status,
      responseErrorText,
    )
  ) {
    // Do not let a relay with a non-settling cancel() block protocol fallback.
    void response.body?.cancel().catch(() => undefined);
    rememberChatFallback(provider.id, request.modelId);
    void updateModelCapabilities(provider.id, request.modelId, {
      supportsResponses: false,
    });
    const compatibilityDetail = responseErrorText
      ? "（工具调用历史格式不兼容）"
      : "";
    onProgress?.(
      `Responses API 返回 ${response.status}${compatibilityDetail}，已自动切换到 Chat Completions 兼容接口…`,
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
      onProgress,
      "openai-chat",
      runtime,
      attemptBudget,
    );
  }
  const retryableKeyStatus =
    apiKeys.length > 1 &&
    /^(401|403|408|425|429|5\d\d)$/.test(String(response.status));
  if (retryableKeyStatus)
    apiKeyCooldownPool.markUnavailable(provider.id, keyIndex);
  const nextKeyIndex = retryableKeyStatus ? nextApiKeyIndex() : undefined;
  if (!response.ok)
    if (nextKeyIndex !== undefined && !signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      onProgress?.(
        `上游返回 ${response.status}，自动切换备用 API Key（${nextKeyIndex + 1}/${apiKeys.length}）…`,
      );
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
        onProgress,
        protocolOverride,
        {
          provider,
          activeSkills: runtime?.activeSkills ?? "",
          omitImageInputs: runtime?.omitImageInputs,
          keyIndex: nextKeyIndex,
          triedKeyIndexes: [...triedKeyIndexes],
        },
        attemptBudget,
      );
    }
  if (!response.ok)
    throw new Error(
      `请求失败 (${response.status}): ${(responseErrorText ?? (await readResponseText(response, signal))).slice(0, 500)}`,
    );
  apiKeyCooldownPool.markHealthy(provider.id, keyIndex);
  if (/text\/event-stream/i.test(response.headers.get("content-type") || ""))
    return parseStreamedTurn(
      protocol,
      response,
      signal,
      onText,
      onReasoning,
      onProgress,
      reasoning.reasoningMode !== "none" ? 180_000 : undefined,
      compatibility.streamMode,
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
      reasoningContent: message.reasoning_content || message.reasoning || "",
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

function blockedVerificationEvents(
  textOffset: number,
  message: string,
): AgentEvent[] {
  return [
    {
      type: "final_response",
      textOffset,
      startedAt: Date.now(),
    },
    { type: "text", delta: message },
    // A verification hard-stop is a PAUSE (the model couldn't prove its claims
    // and stopped), not a request for user input. Only request_user_input /
    // reportsMissingInput map to the "待补充" (blocked) badge.
    { type: "done", outcome: "paused" },
  ];
}

export async function* runAgent(
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps: RunAgentDeps = {},
): AsyncGenerator<AgentEvent> {
  const streamTurn = deps.streamTurn ?? defaultStreamTurn;
  const getProvider = deps.getProvider ?? getProviderWithKey;
  const runStartedAt = Date.now();
  const root = path.resolve(request.workspacePath);
  const browserSessionId =
    request.connectionSessionId || request.taskId || requestId;
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
  let timelineTextLength = 0;
  // Keep a compact, request-local proof ledger outside the model context.
  // Runtime history may be compacted during long tasks, but completion proof
  // must survive until the request actually finishes.
  const evidenceHistory: HistoryItem[] = [];
  const turnDiffTracker = new TurnDiffTracker(root);
  fileReadCache = new FileReadCache(); // Reset module-level cache for new request
  const stopHooks = createDefaultStopHooks();
  // Initialize conversation persistence (append-only JSONL)
  const conversationWriter = new ConversationWriter(
    requestId,
    root,
    request.modelId ?? "unknown",
    request.providerId ?? "unknown",
    request.taskId,
  );
  conversationWriter.start();
  // Fire SessionStart lifecycle hooks (non-blocking, best effort)
  runHooks("SessionStart", { workspaceRoot: root, requestId }).catch(() => {});
  // Plan mode semantic authorization — grants semantic permissions after plan approval
  const planAuth = new PlanSemanticAuth();
  // Tool stats tracking — reset per session
  const toolStats = resetToolStats();
  const activeConnectionFacts = new Map<string, string>();
  let requestedGitOps = requestedGitOperations(history);
  let requestedCodingOps = requestedCodingOperations(history);
  let requestedCodingEvidenceOps =
    codingOperationsRequiringToolEvidence(requestedCodingOps);
  let requestedBrowserOps = requestedBrowserOperations(history);
  let executionRequired =
    requestedBrowserOps.size > 0 ||
    requestedGitOps.size > 0 ||
    requestedCodingEvidenceOps.size > 0;
  let toolsEnabled = !isCasualGreeting(request.messages.at(-1));
  let latestUserRequest = relevantVerificationRequestContent(history);
  let advisoryOnly = isAdvisoryOnlyRequest(latestUserRequest);
  const plannerCoordinator = isPlannerCoordinator(request);
  let activeSkillInstructions =
    await loadActiveSkillInstructions(latestUserRequest);
  const runtimeSkillInstructions = () =>
    [
      activeSkillInstructions,
      "Always answer the latest real user request. Earlier unfinished actions are context only: do not resume them or report their blockers as the current result unless the latest request explicitly says to continue/retry them or asks for their status. A new informational question supersedes an older action goal.",
      browserIsOpen(browserSessionId)
        ? "This task already has a live browser session. Start browser work with browser_snapshot to inspect the current page and obtain fresh element references. Do not ask the user for a URL or click target until browser_snapshot reports that the session is unavailable; the current page is the target unless the user explicitly says otherwise."
        : "",
      advisoryOnly
        ? "本轮用户明确要求只咨询、不改动。可以使用只读工具核对信息，但不得修改文件、运行会产生副作用的命令，也不得执行 Git 或发布操作；直接给出方案、步骤和取舍。"
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const modelRuntime: ModelTurnRuntime = {
    provider: await getProvider(request.providerId),
    activeSkills: runtimeSkillInstructions(),
  };
  await agentHooks.run(
    "SessionStart",
    { requestId, taskId: request.taskId },
    signal,
  );
  const requestContainsImages = hasImageAttachments(history);
  const selectedRuntimeModel = modelRuntime.provider.models.find(
    (model) => model.modelId === request.modelId,
  );
  if (
    requestContainsImages &&
    selectedRuntimeModel &&
    imageInputSupport(
      selectedRuntimeModel,
      effectiveOpenAiProtocol(
        modelRuntime.provider.id,
        modelRuntime.provider.protocol,
        request.modelId,
      ),
    ) === "unsupported"
  )
    modelRuntime.omitImageInputs = true;
  const usage = { input: 0, output: 0, cached: 0 };
  let lastPromptTokens = 0;
  let round = 0,
    stalledRounds = 0,
    closingVerificationRounds = 0,
    lastFingerprint = "";
  let hasRetainedVerificationText = false;
  // Retry/claim budgets for this run, grouped as the first slice of an explicit
  // run-state object. Each counter caps how often the loop will re-prompt the
  // model for a specific unproven claim before giving up.
  const budgets = {
    unverifiedBrowserClaims: 0,
    unverifiedGitClaims: 0,
    unverifiedCodingClaims: 0,
    staleBrowserContextReplies: 0,
    autoContinues: 0,
    emptyTurns: 0,
  };
  // Previous-round context, grouped as a run-state slice: the last activity and
  // any failure carried into the next round's narrative, plus the last tool
  // narrative used to de-duplicate repeated progress text.
  const prevRound: {
    activity?: AgentActivity;
    failure?: AgentActivity;
    toolNarrative: string;
  } = { toolNarrative: "" };
  // Execution-plan tracking, grouped as a run-state slice. `steps` is the
  // active numbered plan, `cursor` the current step, `fallbackActive` whether
  // the plan was synthesized from requested ops rather than model narration.
  const plan = {
    steps: defaultExecutionPlan(requestedCodingOps),
    cursor: 0,
    fallbackActive: false,
  };
  plan.fallbackActive = plan.steps.length > 0;
  let imageFallbackNoticeSent = false;
  while (!signal.aborted) {
    const pendingParentInstructions = drainSubagentMessages(requestId);
    const pendingSteering = turnSteeringQueue.drain(requestId);
    if (pendingSteering.length) {
      // Steering is a new user turn inside the same running request. Append it
      // before computing completion requirements so the old goal cannot keep
      // forcing operations (for example an earlier upload) after the user has
      // switched to an informational question.
      for (const message of pendingSteering)
        history.push({
          kind: "message",
          role: "user",
          content: `<user_steer>${message}</user_steer>`,
        });
      latestUserRequest = relevantVerificationRequestContent(history);
      requestedGitOps = requestedGitOperations(history);
      requestedCodingOps = requestedCodingOperations(history);
      requestedCodingEvidenceOps =
        codingOperationsRequiringToolEvidence(requestedCodingOps);
      requestedBrowserOps = requestedBrowserOperations(history);
      executionRequired =
        requestedBrowserOps.size > 0 ||
        requestedGitOps.size > 0 ||
        requestedCodingEvidenceOps.size > 0;
      toolsEnabled = !isCasualGreeting({
        role: "user",
        content: latestUserRequest,
      });
      advisoryOnly = isAdvisoryOnlyRequest(latestUserRequest);
      activeSkillInstructions =
        await loadActiveSkillInstructions(latestUserRequest);
      modelRuntime.activeSkills = runtimeSkillInstructions();
      budgets.unverifiedBrowserClaims = 0;
      budgets.unverifiedGitClaims = 0;
      budgets.unverifiedCodingClaims = 0;
      budgets.staleBrowserContextReplies = 0;
      budgets.autoContinues = 0;
      budgets.emptyTurns = 0;
      stalledRounds = 0;
      closingVerificationRounds = 0;
      lastFingerprint = "";
      hasRetainedVerificationText = false;
      plan.steps = defaultExecutionPlan(requestedCodingOps);
      plan.cursor = 0;
      plan.fallbackActive = plan.steps.length > 0;
    }
    const codingEvidenceAtRoundStart =
      successfulCodingEvidence(evidenceHistory);
    const browserEvidenceAtRoundStart =
      successfulBrowserEvidence(evidenceHistory);
    const gitEvidenceAtRoundStart = successfulGitEvidence(evidenceHistory);
    const unavailableGitAtRoundStart =
      unavailableGitOperations(evidenceHistory);
    const evidenceComplete =
      missingRequestedCodingOperations(
        requestedCodingEvidenceOps,
        codingEvidenceAtRoundStart,
      ).length === 0 &&
      missingRequestedBrowserOperations(
        requestedBrowserOps,
        browserEvidenceAtRoundStart,
      ).length === 0 &&
      missingRequestedGitOperations(
        requestedGitOps,
        gitEvidenceAtRoundStart,
      ).every((operation) => unavailableGitAtRoundStart.has(operation)) &&
      !listSubagents(requestId).some((agent) => !agent.collected);
    const hasPendingInstructions =
      pendingParentInstructions.length > 0 || pendingSteering.length > 0;
    const forcedClosingFinalization =
      !hasPendingInstructions &&
      shouldFinalizeClosingVerification(closingVerificationRounds);
    const finalizationMode = forcedClosingFinalization
      ? evidenceComplete
        ? "evidence-complete"
        : "limit-reached"
      : executorFinalizationMode({
          agentRole: request.agentRole,
          completedRounds: round,
          elapsedMs: Date.now() - runStartedAt,
          evidenceComplete,
          hasPendingInstructions,
        });
    round += 1;
    const finalizationRoleLabel =
      request.agentRole === "planner" ? "规划模型" : "执行模型";
    yield {
      type: "progress",
      message:
        forcedClosingFinalization
          ? "检测到连续重复的收尾复核，正在停止继续检查并汇总结论…"
          : finalizationMode === "evidence-complete"
          ? `${finalizationRoleLabel}已完成主要修改和验证，正在收尾总结…`
          : finalizationMode === "limit-reached"
            ? `${finalizationRoleLabel}已达到运行上限，正在汇总已有结果和未完成项…`
            : nextExecutionNarrative(
                prevRound.activity,
                prevRound.failure,
              ),
    };
    if (
      request.contextWindow &&
      lastPromptTokens >= request.contextWindow * 0.92
    ) {
      const before = history.length;
      const compactionWindowId = `${requestId}:context:${round}`;
      yield {
        type: "context_compaction",
        phase: "started",
        windowId: compactionWindowId,
        beforeItems: before,
        promptTokens: lastPromptTokens,
      };
      await agentHooks.run(
        "BeforeCompact",
        {
          requestId,
          taskId: request.taskId,
          payload: { historyItems: before, promptTokens: lastPromptTokens },
        },
        signal,
      );
      const contextCompacted = compactRuntimeHistory(
        history,
        lastPromptTokens >= request.contextWindow * 0.99,
        activeConnectionFacts.values(),
      );
      yield {
        type: "context_compaction",
        phase: "completed",
        windowId: compactionWindowId,
        beforeItems: before,
        afterItems: history.length,
        promptTokens: lastPromptTokens,
        changed: contextCompacted,
      };
      if (contextCompacted) {
        const activity: AgentActivity = {
          id: randomUUID(),
          requestId,
          tool: "read_many_files",
          status: "success",
          title: "压缩运行上下文",
          startedAt: Date.now(),
          completedAt: Date.now(),
          input: {},
          textOffset: timelineTextLength,
          narrative:
            "上下文接近预算，先压缩较早的运行记录，保留当前任务所需事实后继续执行。",
          output: `已将 ${before} 条运行记录压缩为 ${history.length} 条，Agent 将继续执行`,
          round,
          progress: "advanced",
        };
        await agentHooks.run(
          "AfterCompact",
          {
            requestId,
            taskId: request.taskId,
            payload: {
              beforeItems: before,
              afterItems: history.length,
              promptTokens: lastPromptTokens,
            },
          },
          signal,
        );
        yield { type: "activity", activity };
        lastPromptTokens = 0;
      }
    }
    for (const message of pendingParentInstructions)
      history.push({
        kind: "message",
        role: "user",
        content: `<parent_instruction>${message}</parent_instruction>`,
      });
    if (finalizationMode)
      history.push({
        kind: "message",
        role: "user",
        content:
          forcedClosingFinalization
            ? "<runtime_finalization>你已经连续多轮声称正在进行最后或最终确认，但只是在追加无改动的复核。现在禁止继续调用工具或重复检查。请立即根据已有工具证据给出结论：已确认事实、完成的改动、成功和失败的验证，以及仍无法确认的事项。不得把未完成项写成已完成。</runtime_finalization>"
            : finalizationMode === "evidence-complete"
            ? request.agentRole === "planner"
              ? "<runtime_finalization>执行模型已返回覆盖本次要求的成功工具证据，规划阶段现在进入收尾。不要再派发新的执行 Agent，也不要重复复核。请依据已收集的执行结果给出简洁最终总结：完成内容、修改文件、验证结果、可用地址和真实残留问题。不得声称未经执行模型证实的事项。</runtime_finalization>"
              : "<runtime_finalization>已有成功工具记录覆盖本次要求，执行预算现在进入收尾阶段。不要再调用工具、不要继续修改，也不要追加重复验证。请仅依据现有工具结果给出简洁最终总结：完成内容、修改文件、验证结果、可用地址和真实残留问题。不得声称未验证的事项。</runtime_finalization>"
            : request.agentRole === "planner"
              ? "<runtime_finalization>规划模型已达到运行预算上限。不要再派发或等待新的执行 Agent。请根据已收集的执行结果立即汇总：已完成内容、修改文件、成功和失败的验证、可用地址，以及尚未完成或无法确认的事项。必须如实区分完成项与残留项。</runtime_finalization>"
              : "<runtime_finalization>执行 Agent 已达到运行预算上限。不要再调用工具或继续修改。请根据现有工具结果立即汇总：已完成内容、修改文件、成功和失败的验证、可用地址，以及尚未完成或无法确认的事项。必须如实区分完成项与残留项。</runtime_finalization>",
      });
    let turn: Turn | undefined,
      streamedText = "",
      streamedReasoning = "";
    const turnTextStartOffset = timelineTextLength;
    const resetTurnTextEvent = (
      replacement?: string,
      reason: "stream_retry" | "runtime_verification" =
        "runtime_verification",
    ): AgentEvent => ({
      type: "text_reset",
      textOffset: turnTextStartOffset,
      replacement,
      reason,
    });
    const bufferModelText =
      browserIsOpen(browserSessionId) ||
      requestedBrowserOps.size > 0 ||
      requestedGitOps.size > 0 ||
      requestedCodingEvidenceOps.size > 0 ||
      budgets.unverifiedBrowserClaims > 0 ||
      budgets.unverifiedGitClaims > 0 ||
      budgets.unverifiedCodingClaims > 0 ||
      listSubagents(requestId).some((agent) => !agent.collected);
    if (
      requestContainsImages &&
      modelRuntime.omitImageInputs &&
      !imageFallbackNoticeSent
    ) {
      imageFallbackNoticeSent = true;
      yield {
        type: "progress",
        message:
          "当前模型不支持图片输入，已跳过图片附件，继续根据文字和工作区内容处理…",
      };
    }
    let imageRetryAttempted = false;
    const turnAttemptBudget = new ModelAttemptBudget(3);
    for (;;) {
      try {
        for await (const event of streamTurn({
          root,
          requestId,
          request,
          history,
          signal,
          toolsEnabled: finalizationMode ? false : toolsEnabled,
          requireToolCall: finalizationMode
            ? false
            : shouldRequireCodingTool(
                request.modelId,
                requestedCodingEvidenceOps,
                successfulCodingEvidence(evidenceHistory),
                evidenceHistory,
              ),
          runtime: modelRuntime,
          attemptBudget: turnAttemptBudget,
        })) {
          if (event.type === "complete") turn = event.turn;
          else if (event.type === "reasoning") {
            streamedReasoning += event.delta;
            yield { type: "reasoning", delta: event.delta };
          } else if (event.type === "progress")
            yield { type: "progress", message: event.message };
          else if (event.type === "reasoning_reset") {
            streamedReasoning = "";
            yield { type: "reasoning_reset" };
          } else if (event.type === "text_reset") {
            // Upstream broke mid-answer and is being retried. A divergent retry
            // carries its replacement prefix in the reset event so the renderer
            // never observes an empty intermediate answer.
            streamedText = event.replacement ?? "";
            if (!bufferModelText) {
              timelineTextLength = turnTextStartOffset + streamedText.length;
              yield resetTurnTextEvent(streamedText, "stream_retry");
            }
          } else {
            streamedText += event.delta;
            if (!bufferModelText) {
              timelineTextLength += event.delta.length;
              yield { type: "text", delta: event.delta };
            }
          }
        }
        break;
      } catch (error) {
        const canRetryWithoutImages =
          requestContainsImages &&
          !imageRetryAttempted &&
          !modelRuntime.omitImageInputs &&
          !turn &&
          !streamedText &&
          !streamedReasoning &&
          isUnsupportedImageInputError(error);
        if (!canRetryWithoutImages) throw error;
        imageRetryAttempted = true;
        modelRuntime.omitImageInputs = true;
        if (!imageFallbackNoticeSent) {
          imageFallbackNoticeSent = true;
          yield {
            type: "progress",
            message:
              "上游模型不接受图片输入，已自动跳过图片附件并用文字上下文重试…",
          };
        }
      }
    }
    if (!turn) throw new Error("模型流结束但没有完成结果");
    if (turn.reasoningContent && !streamedReasoning.trim())
      yield { type: "reasoning", delta: turn.reasoningContent };
    lastPromptTokens = turn.usage.input;
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    usage.cached += turn.usage.cached;
    // input/output/cached accumulate across rounds for billing; promptTokens is
    // the latest round's prompt size, i.e. the real current context occupancy.
    yield { type: "usage", ...usage, promptTokens: lastPromptTokens };
    if (!turn.text.trim() && !turn.calls.length) {
      if (budgets.emptyTurns < 2) {
        budgets.emptyTurns += 1;
        yield {
          type: "progress",
          message: `上游返回空响应，正在自动恢复（第 ${budgets.emptyTurns + 1} 次尝试）…`,
        };
        history.push({
          kind: "message",
          role: "user",
          content:
            "<runtime_verification>上一轮上游返回了空响应：没有正文，也没有工具调用。任务尚未完成。请从现有历史和工具结果继续，输出最终结论或立即调用下一步工具，不要再次返回空内容。</runtime_verification>",
        });
        continue;
      }
      yield {
        type: "error",
        message:
          "模型连续返回空响应，KCode 无法确认任务已完成。请重试或更换模型通道。",
      };
      return;
    }
    budgets.emptyTurns = 0;
    const requestedUserInput = hasRequestedUserInputEvidence(evidenceHistory);
    const reportsMissingInput = reportsMissingRequiredUserInput(turn.text);
    const unsupportedOverallCompletion = isUnsupportedTaskCompletionClaim(
      turn.text,
      executionRequired,
      evidenceHistory,
    );
    const browserEvidence = successfulBrowserEvidence(evidenceHistory);
    const staleBrowserContextReply =
      !turn.calls.length &&
      browserIsOpen(browserSessionId) &&
      !browserEvidence.has("verify") &&
      reportsMissingBrowserTarget(turn.text);
    if (staleBrowserContextReply && budgets.staleBrowserContextReplies < 2) {
      budgets.staleBrowserContextReplies += 1;
      if (!bufferModelText && streamedText)
        hasRetainedVerificationText = true;
      history.push({
        kind: "message",
        role: "assistant",
        content: turn.text,
        reasoningContent: turn.reasoningContent,
      });
      history.push({
        kind: "message",
        role: "user",
        content:
          "<runtime_verification>当前任务已有仍在运行的浏览器页面，不缺少 URL 或点击目标。请立即调用 browser_snapshot 读取当前页面并取得最新元素引用，再根据页面状态继续；只有 browser_snapshot 明确报告页面已关闭后，才可以请求用户补充网址。</runtime_verification>",
      });
      continue;
    }
    const claimedBrowserOps = claimedBrowserOperations(turn.text);
    const requiredBrowserOps = new Set<BrowserOperation>([
      ...requestedBrowserOps,
      ...claimedBrowserOps,
    ]);
    const missingBrowserEvidence = missingRequestedBrowserOperations(
      requiredBrowserOps,
      browserEvidence,
    );
    const unsupportedBrowserClaims = missingBrowserEvidence.filter(
      (operation) => claimedBrowserOps.has(operation),
    );
    const browserLabels = {
      open: "打开网页",
      type: "填写网页",
      click: "点击网页",
      verify: "交互后页面验证",
    } as const;
    const browserBlocked =
      !turn.calls.length &&
      missingBrowserEvidence.length > 0 &&
      unsupportedBrowserClaims.length === 0 &&
      !unsupportedOverallCompletion &&
      (finalizationMode === "limit-reached" ||
        requestedUserInput ||
        reportsMissingInput);
    if (
      !turn.calls.length &&
      missingBrowserEvidence.length &&
      !browserBlocked
    ) {
      if (budgets.unverifiedBrowserClaims < 2) {
        budgets.unverifiedBrowserClaims += 1;
        if (!bufferModelText && streamedText)
          hasRetainedVerificationText = true;
        const unsupportedClaimNotice = unsupportedBrowserClaims.length
          ? `你上一段文字声称已经完成${unsupportedBrowserClaims.map((operation) => browserLabels[operation]).join("、")}，但没有对应的成功工具记录；该段未经验证的文字已撤回。`
          : "";
        history.push({
          kind: "message",
          role: "assistant",
          content: turn.text,
          reasoningContent: turn.reasoningContent,
        });
        history.push({
          kind: "message",
          role: "user",
          content: plannerCoordinator
            ? `<runtime_verification>${unsupportedClaimNotice}协作网页任务仍缺少执行模型的成功工具结果：${missingBrowserEvidence.join(", ")}。请调用 spawn_agent，把目标页面、交互步骤和验收条件交给 role=\"executor\" 的执行 Agent，再调用 wait_agent 复核页面快照；如果相关操作实际未发生且并非用户要求，请明确撤回声明，不要编造工具结果。</runtime_verification>`
            : `<runtime_verification>${unsupportedClaimNotice}本次网页任务仍缺少成功工具结果：${missingBrowserEvidence.join(", ")}。属于用户要求的操作请立即调用 browser_open/browser_click/browser_type 实际执行，填写或点击后必须再调用 browser_snapshot 验证新页面。如果相关操作实际未发生且并非用户要求，请明确撤回声明。若确实缺少无法自行获取的网址、登录信息、验证码或必要人工操作，请调用 request_user_input，准确列出需要用户补充的内容。</runtime_verification>`,
        });
        continue;
      }
      if (!bufferModelText && streamedText) {
        timelineTextLength = turnTextStartOffset;
        streamedText = "";
        yield resetTurnTextEvent();
      }
      closeSubagentMessageQueue(requestId);
      const missingBrowserLabels = missingBrowserEvidence
        .map((operation) => browserLabels[operation])
        .join("、");
      const blockedBrowserMessage =
        !unsupportedOverallCompletion &&
        !unsupportedBrowserClaims.length &&
        turn.text.trim()
          ? `${turn.text.trim()}\n\n本轮未得到${missingBrowserLabels}的成功浏览器工具记录，任务已暂停；未确认页面交互已经完成。`
          : `本轮未得到${missingBrowserLabels}的成功浏览器工具记录，任务已暂停；未确认页面交互已经完成。`;
      timelineTextLength = turnTextStartOffset + blockedBrowserMessage.length;
      for (const event of blockedVerificationEvents(
        turnTextStartOffset,
        blockedBrowserMessage,
      ))
        yield event;
      return;
    }
    const gitEvidence = successfulGitEvidence(evidenceHistory);
    const claimedGitOps = claimedGitOperations(turn.text);
    const requiredGitOps = new Set([...requestedGitOps, ...claimedGitOps]);
    const unavailableGitEvidence = unavailableGitOperations(evidenceHistory);
    const unavailableGitClaims = claimedUnavailableGitOperations(turn.text);
    const missingGitEvidence = missingRequestedGitOperations(
      requiredGitOps,
      gitEvidence,
    ).filter(
      (operation) =>
        !(
          !claimedGitOps.has(operation) &&
          unavailableGitEvidence.has(operation) &&
          unavailableGitClaims.has(operation)
        ),
    );
    const unsupportedGitClaims = missingGitEvidence.filter((operation) =>
      claimedGitOps.has(operation),
    );
    const unauthorizedGitClaims = unsupportedGitClaims.filter(
      (operation) => !requestedGitOps.has(operation),
    );
    const gitBlocked =
      !turn.calls.length &&
      missingGitEvidence.length > 0 &&
      unsupportedGitClaims.length === 0 &&
      !unsupportedOverallCompletion &&
      (finalizationMode === "limit-reached" ||
        requestedUserInput ||
        reportsMissingInput);
    if (!turn.calls.length && missingGitEvidence.length && !gitBlocked) {
      if (budgets.unverifiedGitClaims < 2) {
        budgets.unverifiedGitClaims += 1;
        if (!bufferModelText && streamedText)
          hasRetainedVerificationText = true;
        const unsupportedClaimNotice = unsupportedGitClaims.length
          ? `你上一段文字声称 Git/发布操作已经完成（${unsupportedGitClaims.join(", ")}），但没有对应的成功工具记录；该段未经验证的文字已撤回。`
          : "";
        const unauthorizedClaimNotice = unauthorizedGitClaims.length
          ? `其中 ${unauthorizedGitClaims.join(", ")} 未经用户明确授权，不得为了补证据而执行，只能撤回并说明真实状态。`
          : "";
        history.push({
          kind: "message",
          role: "assistant",
          content: turn.text,
          reasoningContent: turn.reasoningContent,
        });
        history.push({
          kind: "message",
          role: "user",
          content: plannerCoordinator
            ? `<runtime_verification>${unsupportedClaimNotice}${unauthorizedClaimNotice}协作 Git/发布任务仍缺少执行模型的成功工具结果：${missingGitEvidence.join(", ")}。仅对用户明确要求的 Git 操作调用 spawn_agent，把目标和验证要求交给 role=\"executor\" 的执行 Agent，再调用 wait_agent 复核远端结果；不要只总结计划。</runtime_verification>`
            : `<runtime_verification>${unsupportedClaimNotice}${unauthorizedClaimNotice}本次 Git/发布任务仍缺少成功工具结果：${missingGitEvidence.join(", ")}。仅对用户明确要求的 Git 操作实际调用工具；优先用 git_status/git_log 检查本地状态，用 git_remote_status 校验远端推送，不要抓取 GitHub HTML 页面验证提交。需要验证 Actions 时再使用 gh run list/gh run view。若确实缺少无法自行确定的仓库、remote、分支、发布目标或授权信息，请调用 request_user_input，准确列出需要用户补充的内容。</runtime_verification>`,
        });
        continue;
      }
      if (!bufferModelText && streamedText) {
        timelineTextLength = turnTextStartOffset;
        streamedText = "";
        yield resetTurnTextEvent();
      }
      closeSubagentMessageQueue(requestId);
      const blockedGitMessage =
        !unsupportedOverallCompletion &&
        !unsupportedGitClaims.length &&
        turn.text.trim()
          ? `${turn.text.trim()}\n\n本轮未得到 ${missingGitEvidence.join(", ")} 的成功 Git 工具记录，任务已暂停；未执行未经确认的提交、推送或发布。`
          : `本轮未得到 ${missingGitEvidence.join(", ")} 的成功 Git 工具记录，任务已暂停；未执行未经确认的提交、推送或发布。`;
      timelineTextLength = turnTextStartOffset + blockedGitMessage.length;
      for (const event of blockedVerificationEvents(
        turnTextStartOffset,
        blockedGitMessage,
      ))
        yield event;
      return;
    }
    const codingEvidence = successfulCodingEvidence(evidenceHistory);
    const claimedCodingOps = claimedCodingOperations(turn.text);
    const requiredCodingOps = new Set<CodingOperation>([
      ...requestedCodingOps,
      ...claimedCodingOps,
    ]);
    const missingCodingEvidence = missingVerifiedCodingOperations(
      requiredCodingOps,
      claimedCodingOps,
      codingEvidence,
      evidenceHistory,
      requestedCodingOps,
    );
    const missingActionCodingEvidence = missingCodingEvidence.filter(
      (operation) => operation !== "inspect",
    );
    const unsupportedCodingClaims = missingActionCodingEvidence.filter(
      (operation) => claimedCodingOps.has(operation),
    );
    const codingLabels = {
      inspect: "检查",
      modify: "实际修改",
      execute: "执行",
      validate: "修改后验证",
      connect: "建立远程连接",
      upload: "上传文件",
      download: "下载文件",
    } as const;
    const codingBlocked =
      !turn.calls.length &&
      unsupportedCodingClaims.length === 0 &&
      !unsupportedOverallCompletion &&
      (finalizationMode === "limit-reached" ||
        requestedUserInput ||
        reportsBlockedCodingOperations(turn.text, missingActionCodingEvidence));
    // Codex-inspired: if the model already called tools successfully during
    // this run, trust structural evidence over text claims. Only block when
    // zero tool activity exists (pure text hallucination).
    const hasToolActivity = hasSuccessfulToolEvidence(evidenceHistory);
    if (
      !turn.calls.length &&
      missingActionCodingEvidence.length &&
      !codingBlocked &&
      !hasToolActivity
    ) {
      if (budgets.unverifiedCodingClaims < 2) {
        budgets.unverifiedCodingClaims += 1;
        if (!bufferModelText && streamedText)
          hasRetainedVerificationText = true;
        const unsupportedClaimNotice = unsupportedCodingClaims.length
          ? `你上一段文字声称已经完成${unsupportedCodingClaims.map((operation) => codingLabels[operation]).join("、")}，但没有对应的成功工具记录；该段未经验证的文字已撤回。`
          : "";
        history.push({
          kind: "message",
          role: "assistant",
          content: turn.text,
          reasoningContent: turn.reasoningContent,
        });
        history.push({
          kind: "message",
          role: "user",
          content: plannerCoordinator
            ? `<runtime_verification>${unsupportedClaimNotice}协作任务仍缺少执行模型的成功工具结果：${missingActionCodingEvidence.join(", ")}。你是规划与复核 Agent，不能直接修改或运行命令。属于用户要求的操作请立即调用 spawn_agent，将完整计划、目标文件、约束和验收命令交给 role=\"executor\" 的执行 Agent，然后调用 wait_agent 收集并复核真实结果；如果相关操作实际未发生且并非用户要求，请明确撤回声明。</runtime_verification>`
            : `<runtime_verification>${unsupportedClaimNotice}本次编码任务仍缺少成功工具结果：${missingActionCodingEvidence.join(", ")}。不要继续总结或假设文件已经改变；属于用户要求的操作请立即使用工作区工具实际检查和修改，并用 diagnostics 或真实命令验证。如果相关操作实际未发生且并非用户要求，请明确撤回声明。如果只读工具已经确认目标内容正确、问题位于工作区之外或没有可执行的修改目标，请调用 report_no_change 记录具体证据，再明确说明“无需修改”；不要制造无意义改动。若确实缺少无法自行获取的文件、需求、接口字段、外部环境、权限或连接信息，请调用 request_user_input，准确列出需要用户补充的内容。</runtime_verification>`,
        });
        continue;
      }
      if (!bufferModelText && streamedText) {
        timelineTextLength = turnTextStartOffset;
        streamedText = "";
        yield resetTurnTextEvent();
      }
      closeSubagentMessageQueue(requestId);
      const missingCodingLabels = missingActionCodingEvidence
        .map((operation) => codingLabels[operation])
        .join("、");
      // Planner runs can't touch tools directly — they must delegate. If a
      // planner pauses here it means it never got a successful executor result,
      // so say why (executor failed / never spawned) instead of blaming the
      // planner for "not modifying files", which is confusing in collaboration.
      const plannerReason = (() => {
        if (!plannerCoordinator) return "";
        const subs = listSubagents(requestId);
        const failed = subs.find(
          (a) => a.status === "failed" || a.status === "stopped",
        );
        if (failed)
          return `执行 Agent 未成功完成${failed.error ? `：${failed.error}` : ""}`;
        if (!subs.length) return "规划模型本轮未调用执行模型（spawn_agent）";
        return "执行模型未返回成功的工具结果";
      })();
      yield {
        type: "error",
        code: "coding_tool_execution_missing",
        retryable: true,
        userAction: "retry",
        message: plannerCoordinator
          ? `执行 Agent 未返回可验证的${missingCodingLabels}结果${plannerReason ? `（${plannerReason}）` : ""}。请重试或更换支持工具调用的模型。`
          : `模型连续未调用完成本次任务所需的工具（${missingCodingLabels}）。KCode 未确认这些操作已经发生；请重试或切换支持工具调用的模型/协议。`,
      };
      return;
    }
    if (
      !turn.calls.length &&
      unsupportedOverallCompletion &&
      !hasSuccessfulToolEvidence(evidenceHistory)
    ) {
      if (budgets.unverifiedCodingClaims < 2) {
        budgets.unverifiedCodingClaims += 1;
        if (!bufferModelText && streamedText)
          hasRetainedVerificationText = true;
        history.push({
          kind: "message",
          role: "assistant",
          content: turn.text,
          reasoningContent: turn.reasoningContent,
        });
        history.push({
          kind: "message",
          role: "user",
          content:
            "<runtime_verification>你上一段文字声称任务已经完成或问题已经解决，但本轮没有任何可支撑该结论的成功工具记录；该段未经验证的文字已撤回。如果用户要求实际操作，请立即调用相应工具并根据结果继续；如果这只是错误表述，请撤回“已完成”并如实说明当前状态，不得编造执行记录。</runtime_verification>",
        });
        continue;
      }
      if (!bufferModelText && streamedText) {
        timelineTextLength = turnTextStartOffset;
        streamedText = "";
        yield resetTurnTextEvent();
      }
      closeSubagentMessageQueue(requestId);
      const blockedCompletionMessage =
        "已撤回未经工具结果证实的完成声明。本轮没有成功工具记录，任务已暂停，未将该结果视为完成。";
      timelineTextLength =
        turnTextStartOffset + blockedCompletionMessage.length;
      for (const event of blockedVerificationEvents(
        turnTextStartOffset,
        blockedCompletionMessage,
      ))
        yield event;
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
            reasoningContent: turn.reasoningContent,
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
    const hasPrematureCompletionClaim =
      turn.calls.length > 0 &&
      Boolean(
        unsupportedOverallCompletion ||
        unsupportedBrowserClaims.length ||
        unsupportedGitClaims.length ||
        unsupportedCodingClaims.length,
      );
    const roundNarrative =
      turn.calls.length && !hasPrematureCompletionClaim
        ? executionNarrativePreview(
            dedupeExecutionNarrative(turn.text, prevRound.toolNarrative),
          )
        : "";
    if (turn.calls.length && roundNarrative) prevRound.toolNarrative = turn.text;
    const detectedPlan = extractExecutionPlan(turn.text);
    if (
      detectedPlan.length >= 2 &&
      !sameExecutionPlan(plan.steps, detectedPlan)
    ) {
      plan.steps = detectedPlan;
      plan.fallbackActive = false;
      plan.cursor = 0;
    }
    const planSteps = plan.steps.length ? plan.steps : undefined;
    const planStep = planSteps
      ? Math.min(plan.cursor, planSteps.length - 1)
      : undefined;
    const truncated =
      !turn.calls.length &&
      /^(length|max_tokens|max_output_tokens)$/i.test(turn.finishReason ?? "");
    const intendsToContinue =
      !turn.calls.length && isExecutionContinuationNarrative(turn.text || "");
    const collaborationPlanPending =
      plannerCoordinator &&
      !finalizationMode &&
      !turn.calls.length &&
      detectedPlan.length >= 2 &&
      Boolean(
        missingBrowserEvidence.length ||
        missingGitEvidence.length ||
        missingActionCodingEvidence.length,
      );
    const willAutoContinue =
      !turn.calls.length &&
      (truncated || intendsToContinue || collaborationPlanPending) &&
      budgets.autoContinues < 4;
    if (!turn.calls.length && !willAutoContinue)
      yield {
        type: "final_response",
        textOffset: turnTextStartOffset,
        startedAt: Date.now(),
        processKind: hasRetainedVerificationText ? "correction" : undefined,
      };
    if (turn.text) {
      history.push({
        kind: "message",
        role: "assistant",
        content: turn.text,
        reasoningContent: turn.reasoningContent,
      });
      // Coding runs buffer model text until the turn shape is known. Once the
      // turn contains tools, the text is a progress update and belongs in the
      // visible timeline before those activities. The final no-tool turn is
      // still the verified conclusion.
      if (turn.calls.length && bufferModelText && roundNarrative) {
        timelineTextLength += roundNarrative.length;
        yield { type: "text", delta: roundNarrative };
      } else if (
        !turn.calls.length &&
        !willAutoContinue &&
        (bufferModelText || !streamedText)
      ) {
        timelineTextLength += turn.text.length;
        yield { type: "text", delta: turn.text };
      }
    }
    if (!turn.calls.length) {
      // A round with no tool call normally means the model is done. But two
      // cases masquerade as "done" while the task is unfinished: (1) the
      // response was truncated (finish_reason length/max_tokens) before its
      // tool calls arrived; (2) some models — notably Grok — end a round with
      // only a "接下来我会…/next I'll…" narration and no actual tool call.
      // Both would otherwise force the user to type "继续". Detect them and
      // auto-continue a bounded number of times.
      if (willAutoContinue) {
        budgets.autoContinues += 1;
        yield {
          type: "progress",
          message: truncated
            ? "上游说明被截断且未产生工具调用，正在要求模型直接继续执行…"
            : collaborationPlanPending
              ? "协作规划已生成，正在要求规划模型启动执行模型…"
              : detectedPlan.length >= 2
                ? `已整理 ${detectedPlan.length} 个执行步骤，正在要求模型立即调用工具…`
                : "模型只返回了执行说明，正在要求它立即调用具体工具…",
        };
        history.push({
          kind: "message",
          role: "user",
          content: `<runtime_verification>${truncated ? "上一轮响应似乎被截断（未收到完整的工具调用）。" : "你描述了下一步计划，但本轮没有实际调用任何工具。"}如果任务尚未完成，请立即调用相应工具继续执行，不要只描述计划；如果任务确实已经全部完成，请明确给出最终结论。</runtime_verification>`,
        });
        continue;
      }
      // Stop hooks: pluggable checks before accepting completion
      const stopHookResult = stopHooks.evaluate({
        text: turn.text || "",
        turnDiff: undefined, // no tool calls this turn, so no diff
        hadToolCalls: false,
        round,
        stalledRounds,
        mentionedTests: /test|测试|jest|vitest|mocha|pytest/i.test(turn.text || ""),
        testsWereRun: false, // no tool calls means no tests ran
        changedFiles: turnDiffTracker.finalizeTurn().changedFiles,
        userGoal: latestUserRequest,
        hasAnyToolEvidence: hasSuccessfulToolEvidence(evidenceHistory),
      });
      if (stopHookResult.action === "continue" && stopHookResult.inject) {
        history.push({
          kind: "message",
          role: "user",
          content: `<runtime_hook>${stopHookResult.inject}</runtime_hook>`,
        });
        continue;
      }
      closeSubagentMessageQueue(requestId);
      yield {
        type: "done",
        outcome:
          // "待补充" (blocked) is reserved for turns that genuinely need the
          // user to supply something: an explicit request_user_input call or a
          // clear missing-input report. Verification pauses (browser/git/coding
          // couldn't be proven) and hitting the round limit are PAUSES — the
          // conversation can resume, and they must not wear the blocked badge.
          requestedUserInput || reportsMissingInput
            ? "blocked"
            : finalizationMode === "limit-reached" ||
                browserBlocked ||
                gitBlocked ||
                codingBlocked
              ? "paused"
              : "completed",
      };
      return;
    }
    // A productive round refreshes the auto-continue budget.
    budgets.autoContinues = 0;
    history.push({ kind: "calls", calls: turn.calls, rawCalls: turn.rawCalls });
    evidenceHistory.push({
      kind: "calls",
      calls: turn.calls.map(compactEvidenceCall),
      rawCalls: [],
    });
    const roundFingerprints: string[] = [];
    const turnRecords: ToolCallRecord[] = [];
    let roundAdvanced = false;
    let roundLastActivity: AgentActivity | undefined;
    let roundFailedActivity: AgentActivity | undefined;
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
        git_remote_status: "校验远端提交",
        git_diff: "Git 差异",
        git_log: "Git 日志",
        git_show: "Git 查看",
        start_process: "启动进程",
        process_output: "进程输出",
        stop_process: "停止进程",
        diagnostics: "项目诊断",
        report_no_change: "确认无需修改",
        request_user_input: "等待补充信息",
        get_context_remaining: "查询上下文余量",
        web_search: "搜索互联网",
        fetch_url: "读取网页",
        credential_list: "查找本地凭据",
        credential_save: "保存网站凭据",
        credential_forget: "删除本地凭据",
        browser_open: "打开浏览器",
        browser_snapshot: "查看网页",
        browser_click: "点击网页",
        browser_type: "填写网页",
        browser_fill_credential: "填写已保存账号",
        browser_screenshot: "网页截图",
        browser_record_start: "开始网页录制",
        browser_record_stop: "停止网页录制",
        ssh_connect: "连接 SSH",
        ssh_set_workspace: "打开远程工作区",
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
        mcp_list_tools: "读取 MCP 工具",
        mcp_call_tool: "调用 MCP 工具",
        run_command: "运行命令",
      };
      const activity: AgentActivity = {
        id: randomUUID(),
        requestId,
        tool: call.name,
        status: "running",
        title:
          call.name === "spawn_agent" && isPlannerCoordinator(request)
            ? `启动执行模型 · ${request.collaboration?.executor.displayName}`
            : titles[call.name],
        startedAt: Date.now(),
        input:
          call.name === "spawn_agent"
            ? {
                name: String(call.input.name || ""),
                task: String(call.input.task || ""),
                role: String(call.input.role || ""),
                model: isPlannerCoordinator(request)
                  ? request.collaboration?.executor.displayName
                  : undefined,
              }
            : call.name === "message_agent"
              ? {
                  agentId: String(call.input.agentId || ""),
                  message: String(call.input.message || ""),
                }
              : redactedToolInput(call),
        agentRole: request.agentRole,
        providerId: request.providerId,
        modelId: request.modelId,
        reasoningEffort: request.reasoningEffort,
        textOffset: timelineTextLength,
        narrative: roundNarrative || undefined,
        planSteps,
        planStep:
          planSteps && plan.fallbackActive
            ? fallbackExecutionPlanStep(
                call.name,
                call.input,
                planSteps.length,
                planStep ?? 0,
              )
            : planStep,
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
      activity.narrative ||= activityExecutionNarrative(activity);
      const toolTrace = toolRegistry.start({
        requestId,
        activityId: activity.id,
        tool: call.name,
        args: activity.input,
        startedAt: activity.startedAt,
      });
      activity.toolCallId = toolTrace.callId;
      await agentHooks.run(
        "BeforeTool",
        {
          requestId,
          taskId: request.taskId,
          tool: call.name,
          activityId: activity.id,
          payload: activity.input,
        },
        signal,
      );
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
        call.name === "credential_save"
          ? "workspaceWrite"
          : call.name === "credential_forget"
            ? "deletePaths"
            : call.name === "web_search" ||
        call.name === "fetch_url" ||
        call.name === "mcp_list_tools" ||
        call.name === "mcp_call_tool" ||
        call.name === "git_remote_status" ||
        browserTool ||
        call.name === "ssh_connect" ||
        call.name === "ssh_set_workspace" ||
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
                            ? permissionCategoryForCommand(
                                String(call.input.command ?? ""),
                              )
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
        toolRegistry.finish(toolTrace.callId, "denied");
        yield { type: "activity", activity };
        roundLastActivity = activity;
        roundFailedActivity = activity;
        history.push({
          kind: "result",
          callId: call.id,
          content: activity.output,
        });
        continue;
      }
      if (decision === "confirm") {
        // Check approval cache before prompting user
        const approvalCommand =
          call.name === "run_command" || call.name === "ssh_run"
            ? String(call.input.command ?? "")
            : call.name === "start_process"
              ? String(call.input.command ?? "")
              : "";
        const cachedDecision = approvalCommand
          ? approvalCache.check(
              approvalCommand,
              category ?? "runCommands",
              root,
            )
          : "prompt";
        if (cachedDecision === "allow") {
          // Auto-approved by cache — skip dialog
          activity.status = "running";
          toolRegistry.markRunning(toolTrace.callId);
          yield { type: "activity", activity };
        } else if (approvalCommand && planAuth.isAuthorized(approvalCommand)) {
          // Auto-approved by plan semantic auth — skip dialog
          activity.status = "running";
          toolRegistry.markRunning(toolTrace.callId);
          yield { type: "activity", activity };
        } else {
          activity.status = "waiting";
          toolRegistry.markWaiting(toolTrace.callId);
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
            toolRegistry.finish(toolTrace.callId, "denied");
            yield { type: "activity", activity };
            roundLastActivity = activity;
            roundFailedActivity = activity;
            history.push({
              kind: "result",
              callId: call.id,
              content: activity.output,
            });
            continue;
          }
          activity.status = "running";
          toolRegistry.markRunning(toolTrace.callId);
          yield { type: "activity", activity };
        }
      } else yield { type: "activity", activity };
      let finishMutationClaim: ((committed: boolean) => void) | undefined;
      let resultEvidence: Pick<
        ToolResult,
        | "changed"
        | "executed"
        | "mutationAttempted"
        | "noChangeReported"
        | "userInputRequested"
        | "operationEvidence"
        | "browserOperationEvidence"
      > = {};
      try {
        // Start tool timing for stats
        toolStats.startCall(call.id);
        // Run PreToolUse lifecycle hooks — may block tool execution
        const preToolResults = await runHooks("PreToolUse", {
          workspaceRoot: root,
          toolName: call.name,
          toolInput: call.input as Record<string, unknown>,
          requestId,
        });
        if (isBlocked(preToolResults)) {
          const reason = getBlockReason(preToolResults) || "被项目 Hook 阻止";
          activity.status = "denied";
          activity.completedAt = Date.now();
          activity.output = reason;
          toolRegistry.finish(toolTrace.callId, "denied");
          yield { type: "activity", activity };
          roundLastActivity = activity;
          roundFailedActivity = activity;
          history.push({
            kind: "result",
            callId: call.id,
            content: reason,
          });
          continue;
        }
        finishMutationClaim = claimSubagentMutation(
          requestId,
          root,
          mutationPaths(call),
        );
        turnDiffTracker.beforeTool(call.name, call.id, call.input as Record<string, unknown>);
        // Snapshot files before mutation for undo support
        if (call.name === "apply_patch" || call.name === "write_file" || call.name === "delete_path" || call.name === "move_path") {
          const input = call.input as Record<string, unknown>;
          const paths: string[] = [];
          if (call.name === "write_file" && typeof input.file_path === "string") paths.push(input.file_path);
          if (call.name === "delete_path" && typeof input.path === "string") paths.push(input.path);
          if (call.name === "move_path" && typeof input.source === "string") paths.push(input.source);
          if (call.name === "apply_patch" && typeof input.patch === "string") {
            // Extract file paths from patch content
            const patchPaths = input.patch.match(/\*\*\* (?:Update|Delete|Add) File: (.+)/g);
            if (patchPaths) {
              for (const line of patchPaths) {
                const m = line.match(/\*\*\* (?:Update|Delete) File: (.+)/);
                if (m) paths.push(m[1].trim());
              }
            }
          }
          for (const p of paths) {
            const abs = path.isAbsolute(p) ? p : path.join(root, p);
            fileHistory(root, requestId).snapshot(abs);
          }
        }
        // Lightweight admin tool: get_context_remaining — no external execution needed
        if (call.name === "get_context_remaining") {
          const ctxWindow = request.contextWindow ?? 128_000;
          const used = lastPromptTokens || 0;
          const remaining = Math.max(0, ctxWindow - used);
          const pct = ctxWindow > 0 ? Math.round((used / ctxWindow) * 100) : 0;
          const resultOutput = JSON.stringify({
            contextWindow: ctxWindow,
            usedTokens: used,
            remainingTokens: remaining,
            usedPercent: pct,
          });
          finishMutationClaim?.(true);
          turnDiffTracker.afterTool(call.name, call.id, call.input as Record<string, unknown>);
          Object.assign(activity, {
            status: "success",
            completedAt: Date.now(),
            output: resultOutput,
          });
          toolRegistry.finish(toolTrace.callId, "success");
          history.push({
            kind: "result",
            callId: call.id,
            content: JSON.stringify({ success: true, summary: resultOutput, data: {} }),
          });
          evidenceHistory.push({
            kind: "result",
            callId: call.id,
            content: JSON.stringify({ success: true, summary: resultOutput, data: {} }),
          });
          yield { type: "activity", activity };
          roundLastActivity = activity;
          continue;
        }
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
        let lastProgressOutput = "";
        while (true) {
          const step = await execution.next();
          if (step.done) {
            result = step.value;
            break;
          }
          const nextOutput = step.value;
          toolRegistry.progress(toolTrace.callId, nextOutput);
          const verificationStatus = /^\[等待人工验证\]\s*([^。]+)/.exec(
            nextOutput,
          )?.[1];
          if (verificationStatus && !activity.liveStatus) {
            activity.liveStatus = `等待人工验证：${verificationStatus}`;
            yield { type: "activity", activity: { ...activity } };
          }
          if (nextOutput !== lastProgressOutput) {
            if (nextOutput.startsWith(lastProgressOutput))
              yield {
                type: "activity_output",
                activityId: activity.id,
                mode: "append",
                value: nextOutput.slice(lastProgressOutput.length),
              };
            else
              yield {
                type: "activity_output",
                activityId: activity.id,
                mode: "replace",
                value: nextOutput,
              };
            lastProgressOutput = nextOutput;
          }
          activity.output = nextOutput;
        }
        finishMutationClaim?.(true);
        turnDiffTracker.afterTool(call.name, call.id, call.input as Record<string, unknown>);
        const childActivities = result.childActivities;
        const subagentUsage = result.subagentUsage;
        const {
          childActivities: _children,
          subagentUsage: _subagentUsage,
          ...activityResult
        } = result;
        resultEvidence = {
          changed: result.changed,
          executed: result.executed,
          mutationAttempted: result.mutationAttempted,
          noChangeReported: result.noChangeReported,
          userInputRequested: result.userInputRequested,
          operationEvidence: result.operationEvidence,
          browserOperationEvidence: result.browserOperationEvidence,
        };
        const cancelled =
          signal.aborted ||
          /命令已取消|操作已取消|任务已取消/i.test(result.output || "");
        const nonZero = result.exitCode !== undefined && result.exitCode !== 0;
        const hardFailure =
          cancelled || (nonZero && isHardFailure(call, result.output));
        Object.assign(activity, activityResult, {
          status: hardFailure
            ? "failed"
            : nonZero || result.executed === false
              ? "completed"
              : "success",
          completedAt: Date.now(),
          errorSummary: cancelled
            ? "操作已停止"
            : hardFailure
              ? failureSummary(call, result.output, result.exitCode)
              : undefined,
          liveStatus: undefined,
        });
        toolRegistry.finish(
          toolTrace.callId,
          activity.status === "failed" ? "failed" : "success",
        );
        // Record tool execution for turn summary injection
        turnRecords.push({
          toolName: call.name,
          callId: call.id,
          primaryArg: String(
            (call.input as Record<string, unknown>).file_path ??
            (call.input as Record<string, unknown>).path ??
            (call.input as Record<string, unknown>).command ??
            (call.input as Record<string, unknown>).query ??
            ""
          ),
          success: activity.status === "success",
          exitCode: result.exitCode,
          error: activity.status === "failed" ? activity.errorSummary : undefined,
        });
        // Record tool stats
        toolStats.finishCall(call.id, call.name, activity.status === "success", {
          filePath: (call.input as Record<string, unknown>).file_path as string | undefined
            ?? (call.input as Record<string, unknown>).path as string | undefined,
          additions: activity.additions,
          deletions: activity.deletions,
        });
        await agentHooks.run(
          "AfterTool",
          {
            requestId,
            taskId: request.taskId,
            tool: call.name,
            activityId: activity.id,
            payload: {
              status: activity.status,
              changed: resultEvidence.changed,
              executed: resultEvidence.executed,
            },
          },
          signal,
        );
        // Run PostToolUse lifecycle hooks
        const postToolResults = await runHooks("PostToolUse", {
          workspaceRoot: root,
          toolName: call.name,
          toolInput: call.input as Record<string, unknown>,
          toolResult: { success: activity.status === "success", output: activity.output },
          requestId,
        });
        const postToolInjection = collectInjections(postToolResults);
        if (postToolInjection) {
          history.push({
            kind: "result",
            callId: call.id + "_hook",
            content: postToolInjection,
          });
        }
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
        activity.recoverable = isRecoverableGitHubError(error) || undefined;
        activity.completedAt = Date.now();
        activity.output = activity.output
          ? `${activity.output}\n\n${failureOutput}`
          : failureOutput || (cancelled ? "操作已停止" : "工具执行失败");
        activity.errorSummary = cancelled
          ? "操作已停止"
          : failureSummary(call, failureOutput);
        activity.liveStatus = undefined;
        toolRegistry.fail(toolTrace.callId, failureOutput, cancelled);
        await agentHooks.run(
          "AfterTool",
          {
            requestId,
            taskId: request.taskId,
            tool: call.name,
            activityId: activity.id,
            payload: { status: activity.status, error: failureOutput },
          },
          signal,
        );
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
        resultEvidence.changed === true ||
        Boolean(activity.diff) ||
        Boolean(activity.additions) ||
        Boolean(activity.deletions);
      roundAdvanced ||= advanced;
      activity.progress = advanced ? "advanced" : "unchanged";
      yield { type: "activity", activity };
      roundLastActivity = activity;
      if (activity.status === "failed" || activity.status === "denied")
        roundFailedActivity = activity;
      // Spill large output to disk to preserve context tokens
      const spillResult = activity.output
        ? processLargeOutput(activity.output, {
            command: activity.command,
            toolName: call.name,
            callId: call.id,
            requestId,
          })
        : { spilled: false as const, summary: activity.output ?? "", originalSize: 0, lineCount: 0 };
      const effectiveOutput = spillResult.summary;
      const structured: StructuredToolResult = {
        success: activity.status === "success",
        summary:
          activity.errorSummary ??
          (activity.status === "completed"
            ? resultEvidence.executed === false
              ? `${activity.title}未执行`
              : `${activity.title}已执行完成，退出码 ${activity.exitCode ?? "未知"}`
            : `${activity.title}${activity.status === "success" ? "完成" : "未完成"}`),
        data: {
          output: effectiveOutput,
          diff: activity.diff,
          path: activity.path,
          command: activity.command,
          exitCode: activity.exitCode,
          additions: activity.additions,
          deletions: activity.deletions,
          fileChanges: activity.fileChanges,
          changed: resultEvidence.changed,
          executed: resultEvidence.executed,
          mutationAttempted: resultEvidence.mutationAttempted,
          noChangeReported: resultEvidence.noChangeReported,
          userInputRequested: resultEvidence.userInputRequested,
          operationEvidence: resultEvidence.operationEvidence,
          browserOperationEvidence: resultEvidence.browserOperationEvidence,
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
      updateActiveConnectionFacts(
        activeConnectionFacts,
        call,
        structured.success,
      );
      history.push({
        kind: "result",
        callId: call.id,
        content: JSON.stringify(structured),
      });
      evidenceHistory.push(
        compactOperationEvidenceResult(
          call.id,
          call.name,
          structured.success,
          structured.data,
        ),
      );
      // After command execution, detect files that became stale
      if (
        (call.name === "run_command" || call.name === "start_process") &&
        activity.status === "success"
      ) {
        const staleHint = getStaleFileHint(fileReadCache);
        if (staleHint) {
          history.push({
            kind: "result",
            callId: call.id,
            content: staleHint,
          });
        }
      }
    }
    // Finalize turn diff tracking — provides ground truth of file changes
    const turnDiff = turnDiffTracker.finalizeTurn();
    if (turnDiff.hasChanges) {
      evidenceHistory.push({
        kind: "result",
        callId: turnDiffId(round),
        content: JSON.stringify({
          success: true,
          summary: `Turn实际文件变更: ${turnDiff.changedFiles.join(", ")}`,
          data: { turnDiff: true, files: turnDiff.changedFiles.length },
        }),
      });
    }
    // Inject tool execution record into context for next round
    const turnSummary = buildTurnSummary(round, turnRecords, turnDiff);
    if (turnSummary) {
      history.push({
        kind: "message",
        role: "user",
        content: `<tool_execution_record>\n${turnSummary}\n</tool_execution_record>`,
      });
    }
    // Persist round events to JSONL
    for (const call of turn.calls) {
      conversationWriter.toolCall(
        call.id,
        call.name,
        redactedToolInput(call),
      );
    }
    for (const rec of turnRecords) {
      conversationWriter.toolResult(rec.callId, rec.toolName, rec.success, rec.exitCode != null ? `exit ${rec.exitCode}` : undefined);
    }
    prevRound.activity = roundLastActivity;
    prevRound.failure = roundFailedActivity;
    if (
      plan.steps.length &&
      !roundFailedActivity &&
      roundLastActivity &&
      !["report_no_change", "request_user_input"].includes(
        roundLastActivity.tool,
      )
    )
      plan.cursor = Math.min(plan.cursor + 1, plan.steps.length - 1);
    const roundFingerprint = roundFingerprints.join("|");
    closingVerificationRounds = nextClosingVerificationRounds({
      previous: closingVerificationRounds,
      narrative: turn.text,
      hadToolCalls: turn.calls.length > 0,
      madeChanges: roundAdvanced,
    });
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
    const currentStallAction = stallAction(stalledRounds);
    if (currentStallAction === "recover") {
      yield {
        type: "progress",
        message:
          "检测到连续重复操作，正在要求 Agent 保留现有结果并更换执行策略…",
      };
      history.push({
        kind: "message",
        role: "user",
        content:
          "<runtime_stall_recovery>你已经连续多轮使用相同工具输入并得到相同结果。不要再次原样重试。请保留已有成果，检查最近一次失败或阻塞点，然后选择不同的命令或验证方式；已有后台进程时只读取其状态，不要重复启动；确实缺少外部信息时调用 request_user_input；任务已经完成时直接给出最终结论。</runtime_stall_recovery>",
      });
      continue;
    }
    if (currentStallAction === "pause") {
      for (const event of blockedVerificationEvents(
        timelineTextLength,
        `Agent 已暂停：连续 ${STALL_PAUSE_ROUNDS} 轮重复了相同操作且没有取得新进展。已有结果均已保留，可以继续任务并从当前状态更换策略。`,
      ))
        yield event;
      return;
    }
  }
  turnSteeringQueue.clear(requestId);
}
