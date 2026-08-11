import type { AgentActivity, ChatMessage, ReasoningEffort } from "./types";
import type { ContextLedger } from "./context";
import type { TaskRunStatus } from "./task-status";
import type { SshRemoteWorkspace } from "./ssh-remote-types";
import type { ContextWindowState } from "./context-window";
import type { RuntimeThreadStatus } from "./runtime-protocol";

export const uid = () => crypto.randomUUID();
export const EMPTY_ACTIVITIES: AgentActivity[] = [];

export type SettingsSection =
  | "general"
  | "models"
  | "skills"
  | "permissions"
  | "recordings"
  | "remote"
  | "mcp"
  | "automation"
  | "runtime";
export type ThemePreference = "system" | "light" | "dark";
export type AccentPreference =
  "indigo" | "violet" | "emerald" | "blue" | "orange" | "mono";
export const ACCENT_OPTIONS: {
  value: AccentPreference;
  label: string;
  swatch: string;
}[] = [
  { value: "indigo", label: "靛蓝", swatch: "#5b6cff" },
  { value: "violet", label: "紫罗兰", swatch: "#7c3aed" },
  { value: "emerald", label: "翡翠绿", swatch: "#10a37f" },
  { value: "blue", label: "钢青蓝", swatch: "#2563eb" },
  { value: "orange", label: "陶土橙", swatch: "#e0663a" },
  { value: "mono", label: "纯净黑白", swatch: "#171717" },
];
export type QueuedChatMessage = ChatMessage & { queued?: boolean };
export type TaskDrafts = Record<string, string>;

export type TaskCollaboration = {
  mode: "planner-executor";
  executorModelSelection: string;
  executorReasoningEffort?: ReasoningEffort;
};

export type TaskRecord = {
  id: string;
  name: string;
  workspaceName?: string;
  workspacePath: string;
  remoteWorkspace?: SshRemoteWorkspace;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  activities: AgentActivity[];
  modelSelection?: string;
  collaboration?: TaskCollaboration;
  reasoningEffort?: ReasoningEffort;
  contextDirectory?: string;
  runningId?: string;
  runtimeStatus?: RuntimeThreadStatus;
  runStatus?: TaskRunStatus;
  startedAt?: number;
  usage?: {
    input: number;
    output: number;
    cached: number;
    promptTokens?: number;
  };
  usageResolved?: boolean;
  contextSummary?: string;
  compactedMessageCount?: number;
  contextLedger?: ContextLedger;
  pendingTokenEstimate?: number;
  pendingCalibrationKey?: string;
  contextWindowState?: ContextWindowState;
  summarySnapshots?: {
    id: string;
    createdAt: number;
    summary: string;
    ledger: ContextLedger;
    compactedMessageCount?: number;
    modelGenerated: boolean;
    durationMs?: number;
    usage?: { input: number; output: number };
  }[];
  imageSemantics?: Record<string, string>;
  summaryMeta?: {
    modelGenerated: boolean;
    durationMs: number;
    usage?: { input: number; output: number };
  };
  durationMs?: number;
  usedContextCount?: number;
  workspaceView?: "chat" | "editor";
  archived?: boolean;
  parentTaskId?: string;
  forkedFromMessageId?: string;
  scheduledTaskId?: string;
};

export type SidebarTask = Pick<
  TaskRecord,
  | "id"
  | "name"
  | "workspaceName"
  | "workspacePath"
  | "remoteWorkspace"
  | "archived"
  | "runningId"
  | "runStatus"
>;

export type SidebarWorkspaceGroup = {
  workspacePath: string;
  name: string;
  conversations: SidebarTask[];
  remote?: boolean;
  unassigned?: boolean;
};

export type ConversationScrollState = { top: number; atBottom: boolean };

export function storedTaskDrafts(): TaskDrafts {
  try {
    return JSON.parse(
      localStorage.getItem("kcode.taskDrafts") || "{}",
    ) as TaskDrafts;
  } catch {
    return {};
  }
}

export const initialTask = (): TaskRecord => ({
  id: uid(),
  name: "新对话",
  workspacePath: "",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activities: [],
  reasoningEffort: "auto",
  runStatus: "idle",
});
