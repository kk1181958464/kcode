import type { AgentActivity, ChatMessage, ReasoningEffort } from "./types";
import type { ContextLedger } from "./context";
import type { TaskRunStatus } from "./task-status";

export const uid = () => crypto.randomUUID();
export const EMPTY_ACTIVITIES: AgentActivity[] = [];

export type SettingsSection = "general" | "models" | "permissions" | "recordings";

export type TaskRecord = {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  activities: AgentActivity[];
  modelSelection?: string;
  reasoningEffort?: ReasoningEffort;
  runningId?: string;
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
  summarySnapshots?: {
    id: string;
    createdAt: number;
    summary: string;
    ledger: ContextLedger;
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
  archived?: boolean;
};

export type ConversationScrollState = { top: number; atBottom: boolean };

export const initialTask = (): TaskRecord => ({
  id: uid(),
  name: "kcode",
  workspacePath: "D:\\project\\kcode",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activities: [],
  reasoningEffort: "auto",
  runStatus: "idle",
});
