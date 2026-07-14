export type Protocol =
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "gemini-generate-content";
export type ReasoningEffort =
  "auto" | "low" | "medium" | "high" | "xhigh" | "max" | "thinking";
export type ReasoningMode = "none" | "effort" | "toggle" | "budget" | "fixed";
export type PermissionMode = "confirm" | "read-only" | "full-access";
export type PermissionPolicy = {
  workspaceWrite: "allow" | "confirm" | "deny";
  deletePaths: "allow" | "confirm" | "deny";
  runCommands: "allow" | "confirm" | "deny";
  longRunningProcesses: "allow" | "confirm" | "deny";
  network: "allow" | "confirm" | "deny";
  gitPublish: "allow" | "confirm" | "deny";
};
export type AgentToolName =
  | "list_directory"
  | "glob_files"
  | "read_many_files"
  | "path_info"
  | "read_file"
  | "search_code"
  | "apply_patch"
  | "write_file"
  | "make_directory"
  | "move_path"
  | "delete_path"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_show"
  | "start_process"
  | "process_output"
  | "stop_process"
  | "diagnostics"
  | "web_search"
  | "fetch_url"
  | "browser_open"
  | "browser_snapshot"
  | "browser_click"
  | "browser_type"
  | "browser_screenshot"
  | "browser_record_start"
  | "browser_record_stop"
  | "ssh_connect"
  | "ssh_run"
  | "ssh_list_directory"
  | "ssh_read_file"
  | "ssh_write_file"
  | "ssh_disconnect"
  | "mysql_connect"
  | "mysql_connect_via_ssh"
  | "mysql_query"
  | "mysql_disconnect"
  | "spawn_agent"
  | "list_agents"
  | "message_agent"
  | "wait_agent"
  | "stop_agent"
  | "run_command";

export type ContextFile = {
  id: string;
  name: string;
  path: string;
  content: string;
  size: number;
};

export type ImageAttachment = {
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataUrl: string;
  size: number;
};

export type ModelConfig = {
  id: string;
  modelId: string;
  displayName: string;
  protocol: Protocol;
  contextWindow?: number;
  reasoningMode?: ReasoningMode;
  reasoningEfforts?: ReasoningEffort[];
};

export function inferReasoningConfig(
  modelId: string,
  protocol: Protocol,
): Pick<ModelConfig, "reasoningMode" | "reasoningEfforts"> {
  const id = modelId.toLowerCase();
  if (protocol === "anthropic-messages")
    return {
      reasoningMode: "budget",
      reasoningEfforts: ["auto", "low", "medium", "high", "xhigh"],
    };
  if (protocol === "gemini-generate-content")
    return /gemini-(2\.5|3)/.test(id)
      ? {
          reasoningMode: "budget",
          reasoningEfforts: ["auto", "low", "medium", "high"],
        }
      : { reasoningMode: "none", reasoningEfforts: ["auto"] };
  if (/^(o[134]|gpt-5)/.test(id))
    return {
      reasoningMode: "effort",
      reasoningEfforts: /5[.-]?6/.test(id)
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high", "xhigh"],
    };
  if (
    /deepseek-reasoner|kimi-k2|kimi-for-coding|minimax-m2|glm-.*thinking/.test(
      id,
    )
  )
    return { reasoningMode: "fixed", reasoningEfforts: ["thinking"] };
  if (/minimax-m3|glm-4\.5|glm-4\.6|glm-4\.7|glm-5|mimo/.test(id))
    return { reasoningMode: "toggle", reasoningEfforts: ["auto", "thinking"] };
  return { reasoningMode: "none", reasoningEfforts: ["auto"] };
}

export function inferContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase();
  // Keep this list model-specific. Custom provider IDs often resemble an
  // official family name but can expose a different context window.
  if (id === "gpt-5.5") return 258_400;
  if (/^gpt-5\.6(?:-sol)?$/.test(id)) return 353_400;
  if (/^gpt-5\.4(?:-mini)?$/.test(id)) return 258_400;
  if (/^deepseek-(chat|reasoner)$/.test(id)) return 1_000_000;
  if (/^deepseek-v4-(?:pro|flash)$/.test(id)) return 1_000_000;
  if (id === "glm-5.1") return 200_000;
  if (id === "glm-5.2") return 1_000_000;
  if (/^claude-(fable-5|opus-4-(?:6|7|8)|sonnet-(?:4-6|5))(?:-|$)/.test(id))
    return 1_000_000;
  if (/^claude-(haiku-4-5|sonnet-4-5|opus-4-(?:1|5))(?:-|$)/.test(id))
    return 200_000;
  if (
    /^(kimi-(?:k2\.7-code(?:-highspeed)?|k2\.6|k2\.5)|kimi-for-coding(?:-highspeed)?)$/.test(
      id,
    )
  )
    return 262_144;
  if (/^minimax-m3(?:-|$)/.test(id)) return 1_000_000;
  if (/^minimax-m2(?:$|\.(?:1|5|7)(?:-highspeed)?$)/.test(id)) return 204_800;
  return undefined;
}

export type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  enabled: boolean;
  hasApiKey: boolean;
  models: ModelConfig[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string;
  images?: ImageAttachment[];
};

export type ModelRequest = {
  taskId?: string;
  providerId: string;
  modelId: string;
  messages: Pick<ChatMessage, "role" | "content" | "images">[];
  reasoningEffort?: ReasoningEffort;
  permissionMode: PermissionMode;
  permissionPolicy?: PermissionPolicy;
  workspacePath: string;
  contextWindow?: number;
  agentDepth?: number;
  recoveryContext?: string;
};

export type WorkspaceFolder = { name: string; path: string };
export type GitWorkspaceState = {
  available: boolean;
  branch?: string;
  files: number;
  additions: number;
  deletions: number;
  summary: string;
  diff: string;
  error?: string;
};

export type AgentActivity = {
  id: string;
  requestId: string;
  tool: AgentToolName;
  status: "running" | "waiting" | "success" | "failed" | "denied";
  title: string;
  startedAt: number;
  completedAt?: number;
  input: Record<string, unknown>;
  output?: string;
  errorSummary?: string;
  path?: string;
  command?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  exitCode?: number;
  undoable?: boolean;
  undone?: boolean;
  round?: number;
  contentOffset?: number;
  childActivities?: AgentActivity[];
  subagentId?: string;
  subagentName?: string;
  progress?: "advanced" | "unchanged" | "stalled";
};

export type UndoResult = {
  success: boolean;
  message: string;
  conflict?: boolean;
};
export type ContextLedger = {
  goals: string[];
  decisions: string[];
  changedFiles: string[];
  validations: string[];
  failures: string[];
  pending: string[];
};
export type ContextSummaryRequest = {
  taskId: string;
  providerId: string;
  modelId: string;
  source: string;
  ledger: ContextLedger;
};
export type ContextSummaryResult = {
  summary: string;
  ledger: ContextLedger;
  modelGenerated: boolean;
  durationMs: number;
  usage?: { input: number; output: number };
};
export type AgentCheckpoint = {
  id: string;
  taskId?: string;
  startedAt: number;
  status: "running" | "paused" | "done";
  request: ModelRequest;
  subagents?: SubagentCheckpoint[];
};
export type SubagentCheckpoint = {
  id: string;
  name: string;
  task: string;
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  startedAt: number;
  completedAt?: number;
  error?: string;
};
export type BrowserRecordingFile = {
  id: string;
  name: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "interrupted";
  operations: number;
  requests: number;
  jsonPath: string;
  pythonPath?: string;
};

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "usage"; input: number; output: number; cached?: number }
  | { type: "error"; message: string }
  | { type: "done" };

export type AgentEvent =
  ModelEvent | { type: "activity"; activity: AgentActivity };

export type AppUpdateState = {
  status:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "unsupported"
    | "error";
  currentVersion: string;
  version?: string;
  releaseName?: string;
  releaseNotes?: string;
  progress?: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  };
  error?: string;
  portable: boolean;
};

export type KCodeApi = {
  updater: {
    state(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    download(): Promise<AppUpdateState>;
    install(): Promise<void>;
    openRelease(): Promise<void>;
    onState(callback: (state: AppUpdateState) => void): () => void;
  };
  logs: { reveal(): Promise<void> };
  state: {
    load(key: string): Promise<unknown | null>;
    save(key: string, value: unknown): Promise<void>;
    stats(): Promise<{ tasks: number; bytes: number; path: string }>;
    compact(): Promise<{ tasks: number; bytes: number; path: string }>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
  providers: {
    list(): Promise<ProviderConfig[]>;
    save(provider: ProviderConfig, apiKey?: string): Promise<ProviderConfig[]>;
    remove(id: string): Promise<ProviderConfig[]>;
    discover(id: string): Promise<ModelConfig[]>;
  };
  chat: {
    start(request: ModelRequest): Promise<string>;
    cancel(requestId: string): Promise<void>;
    onEvent(
      callback: (requestId: string, event: AgentEvent) => void,
    ): () => void;
    approve(
      requestId: string,
      activityId: string,
      allowed: boolean,
    ): Promise<void>;
    undo(
      workspacePath: string,
      activityId: string,
      force?: boolean,
    ): Promise<UndoResult>;
    cleanup(requestIds: string[], activityIds: string[]): Promise<void>;
    summarize(request: ContextSummaryRequest): Promise<ContextSummaryResult>;
    cancelSummary(taskId: string): Promise<void>;
    checkpoints(): Promise<AgentCheckpoint[]>;
    removeCheckpoint(id: string): Promise<void>;
  };
  context: {
    pickFiles(): Promise<ContextFile[]>;
  };
  workspace: {
    pickFolder(): Promise<WorkspaceFolder | null>;
    gitState(path: string): Promise<GitWorkspaceState>;
  };
  browser: {
    activate(sessionId?: string): Promise<void>;
    close(sessionId?: string): Promise<void>;
    navigate(sessionId: string | undefined, url: string): Promise<void>;
    back(sessionId?: string): Promise<void>;
    forward(sessionId?: string): Promise<void>;
    reload(sessionId?: string): Promise<void>;
    recordings(): Promise<BrowserRecordingFile[]>;
    removeRecording(id: string): Promise<BrowserRecordingFile[]>;
    revealRecording(id: string): Promise<void>;
    onState(
      callback: (state: {
        open: boolean;
        sessionId?: string;
        requestId?: string;
        title?: string;
        url?: string;
        width?: number;
        recording?: boolean;
        canGoBack?: boolean;
        canGoForward?: boolean;
      }) => void,
    ): () => void;
  };
};

declare global {
  interface Window {
    kcode: KCodeApi;
  }
}
