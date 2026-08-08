import type { AgentActivity, AgentEvent } from "./types";
import { classifyRuntimeError } from "./runtime-errors";

/**
 * Versioned, UI-neutral contract for the agent runtime. The renderer may
 * project these events into messages, activities, or a mobile timeline, but
 * the runtime keeps one canonical event identity and ordering.
 */
export const AGENT_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimeEventKind =
  | "message_delta"
  | "reasoning_delta"
  | "progress"
  | "activity"
  | "activity_output_delta"
  | "final_response_boundary"
  | "usage"
  | "context_compaction"
  | "stream_reset"
  | "turn_completed"
  | "turn_interrupted"
  | "turn_failed";

export type RuntimeItemStatus =
  "started" | "streaming" | "completed" | "failed" | "waiting" | "cancelled";

export type RuntimeThreadStatus =
  | "not_loaded"
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export type RuntimeTurnStatus =
  "queued" | "in_progress" | "completed" | "failed" | "interrupted";

export type AgentEventEnvelope = AgentEvent & {
  protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
  eventId: string;
  itemId: string;
  taskId: string;
  requestId: string;
  sequence: number;
  emittedAt: number;
  eventKind: RuntimeEventKind;
  itemStatus: RuntimeItemStatus;
};

export type RuntimeEventPage = {
  events: AgentEventEnvelope[];
  hasMore: boolean;
  nextSequence?: number;
};

export type RuntimeTaskStatusSnapshot = {
  taskId: string;
  requestId: string;
  status: RuntimeThreadStatus;
  turnStatus: RuntimeTurnStatus;
  lastSequence: number;
  updatedAt: number;
};

export type RuntimeTurnSnapshot = {
  threadId: string;
  turnId: string;
  status: RuntimeTurnStatus;
  startedAt: number;
  completedAt?: number;
  lastSequence: number;
};

function isCancelledEvent(event: AgentEvent) {
  return (
    event.type === "error" &&
    (event.code === "cancelled" ||
      /任务已停止|任务已取消|操作已停止|aborted|aborterror/i.test(
        event.message,
      ))
  );
}

function eventKind(event: AgentEvent): RuntimeEventKind {
  switch (event.type) {
    case "text":
      return "message_delta";
    case "reasoning":
      return "reasoning_delta";
    case "progress":
      return "progress";
    case "activity":
      return "activity";
    case "activity_output":
      return "activity_output_delta";
    case "final_response":
      return "final_response_boundary";
    case "usage":
      return "usage";
    case "context_compaction":
      return "context_compaction";
    case "text_reset":
    case "reasoning_reset":
      return "stream_reset";
    case "done":
      return "turn_completed";
    case "error":
      return isCancelledEvent(event) ? "turn_interrupted" : "turn_failed";
  }
}

function itemStatus(event: AgentEvent): RuntimeItemStatus {
  if (event.type === "activity") {
    if (event.activity.status === "waiting") return "waiting";
    if (
      event.activity.status === "failed" ||
      event.activity.status === "denied"
    )
      return "failed";
    if (event.activity.status === "running") return "streaming";
    if (
      event.activity.status === "completed" &&
      event.activity.output === "操作已停止"
    )
      return "cancelled";
    return "completed";
  }
  if (event.type === "done") return "completed";
  if (event.type === "error")
    return isCancelledEvent(event) ? "cancelled" : "failed";
  if (event.type === "final_response") return "streaming";
  if (event.type === "usage") return "completed";
  if (event.type === "context_compaction")
    return event.phase === "completed" ? "completed" : "started";
  return "streaming";
}

function activityItemId(event: AgentEvent) {
  return event.type === "activity"
    ? event.activity.id
    : event.type === "activity_output"
      ? event.activityId
      : undefined;
}

function runtimeItemId(event: AgentEvent, requestId: string, sequence: number) {
  const activityId = activityItemId(event);
  if (activityId) return activityId;
  switch (event.type) {
    case "text":
    case "text_reset":
    case "final_response":
      return `${requestId}:assistant-message`;
    case "reasoning":
    case "reasoning_reset":
      return `${requestId}:reasoning`;
    case "progress":
      return `${requestId}:progress`;
    case "usage":
      return `${requestId}:usage`;
    case "context_compaction":
      return event.windowId;
    case "done":
    case "error":
      return `${requestId}:turn`;
    default:
      return `${requestId}:item:${sequence}`;
  }
}

export function createRuntimeEventEnvelope(
  event: AgentEvent,
  input: {
    taskId: string;
    requestId: string;
    sequence: number;
    emittedAt?: number;
  },
): AgentEventEnvelope {
  const emittedAt = input.emittedAt ?? Date.now();
  const classification =
    event.type === "error" && !event.code
      ? classifyRuntimeError(event.message)
      : undefined;
  const normalizedEvent: AgentEvent =
    event.type === "error" && classification
      ? {
          ...event,
          code: classification.kind,
          retryable: classification.retryable,
          userAction: classification.userAction,
        }
      : event;
  const itemId = runtimeItemId(event, input.requestId, input.sequence);
  return {
    ...normalizedEvent,
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    eventId: `${input.requestId}:${input.sequence}`,
    itemId,
    taskId: input.taskId,
    requestId: input.requestId,
    sequence: input.sequence,
    emittedAt,
    eventKind: eventKind(normalizedEvent),
    itemStatus: itemStatus(normalizedEvent),
  };
}

const agentEventTypes = new Set([
  "text",
  "text_reset",
  "reasoning_reset",
  "final_response",
  "reasoning",
  "progress",
  "usage",
  "context_compaction",
  "error",
  "done",
  "activity",
  "activity_output",
]);

export function isAgentEventEnvelope(
  value: unknown,
): value is AgentEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AgentEventEnvelope>;
  return (
    event.protocolVersion === AGENT_RUNTIME_PROTOCOL_VERSION &&
    typeof event.eventId === "string" &&
    typeof event.itemId === "string" &&
    typeof event.taskId === "string" &&
    typeof event.requestId === "string" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.emittedAt === "number" &&
    typeof event.type === "string" &&
    agentEventTypes.has(event.type)
  );
}

export function isRuntimeTerminalEvent(event: AgentEvent) {
  return event.type === "done" || event.type === "error";
}

export function runtimeTurnStatus(
  event: AgentEvent,
): RuntimeTurnStatus | undefined {
  if (event.type === "done") return "completed";
  if (event.type === "error")
    return isCancelledEvent(event) ? "interrupted" : "failed";
  return undefined;
}

export function runtimeThreadStatus(event: AgentEvent): RuntimeThreadStatus {
  if (event.type === "done")
    return event.outcome === "blocked" ? "waiting" : "completed";
  if (event.type === "error")
    return isCancelledEvent(event) ? "interrupted" : "failed";
  if (event.type === "activity" && event.activity.status === "waiting")
    return "waiting";
  return "running";
}

export function runtimeActivityFromEvent(
  event: AgentEventEnvelope,
): AgentActivity | undefined {
  return event.type === "activity" ? event.activity : undefined;
}
