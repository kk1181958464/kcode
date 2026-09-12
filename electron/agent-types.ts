import type {
  AgentActivity,
  AgentEvent,
  AgentPlanRequirement,
  AgentPlanStepStatus,
  AgentToolName,
  ModelRequest,
} from "../src/types";
import type { BrowserOperation } from "./browser-operation-verification";
import type { CodingOperation } from "./coding-operation-verification";
import type { ModelNetworkTransport } from "./model-network-transport";
import type { ModelAttemptBudget } from "./model-attempt-budget";
import type { ProviderWithKey } from "./gateway";
import type { RuntimeContextSummarizer } from "./runtime-compaction";

export type ToolCall = {
  id: string;
  name: AgentToolName;
  input: Record<string, unknown>;
};

export type ToolResult = Partial<
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
  subagentWait?: {
    completed: number;
    pending: number;
    timedOut: boolean;
    interrupted: boolean;
    progressed: boolean;
  };
  planUpdate?: {
    explanation?: string;
    plan: Array<{
      step: string;
      status: AgentPlanStepStatus;
      requires: AgentPlanRequirement[];
    }>;
  };
};

export type PendingUserInput = {
  question: string;
  fields: string[];
};

export type StructuredToolResult = {
  success: boolean;
  summary: string;
  data: Record<string, unknown>;
  truncated: boolean;
  error?: { message: string; exitCode?: number };
};

export type Turn = {
  text: string;
  reasoningContent?: string;
  calls: ToolCall[];
  rawCalls: unknown[];
  usage: { input: number; output: number; cached: number };
  finishReason?: string;
};

export type TurnStreamEvent =
  | { type: "text"; delta: string }
  | { type: "text_reset"; replacement?: string }
  | { type: "reasoning_reset" }
  | { type: "reasoning"; delta: string }
  | { type: "progress"; message: string }
  | { type: "complete"; turn: Turn };

export type ModelTurnRuntime = {
  provider: ProviderWithKey;
  activeSkills: string;
  workspaceBinding?: string;
  omitImageInputs?: boolean;
  keyIndex?: number;
  triedKeyIndexes?: number[];
  networkTransport?: ModelNetworkTransport;
};

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

export type ProviderResolver = (providerId: string) => Promise<ProviderWithKey>;

export interface RunAgentDeps {
  streamTurn?: ModelStreamFn;
  getProvider?: ProviderResolver;
  summarizeRuntimeContext?: RuntimeContextSummarizer;
}

export type AgentRunner = (
  requestId: string,
  request: ModelRequest,
  signal: AbortSignal,
  deps?: RunAgentDeps,
) => AsyncGenerator<AgentEvent>;

export type HistoryItem =
  | {
      kind: "message";
      id?: string;
      role: "user" | "assistant";
      content: string;
      reasoningContent?: string;
      images?: ModelRequest["messages"][number]["images"];
    }
  | { kind: "calls"; calls: ToolCall[]; rawCalls: unknown[] }
  | { kind: "result"; callId: string; content: string };
