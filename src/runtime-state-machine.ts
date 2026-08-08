import type { AgentEvent } from "./types";
import {
  runtimeThreadStatus,
  runtimeTurnStatus,
  type RuntimeThreadStatus,
  type RuntimeTurnStatus,
} from "./runtime-protocol";

export type RuntimeState = {
  requestId: string;
  threadStatus: RuntimeThreadStatus;
  turnStatus: RuntimeTurnStatus;
  lastSequence: number;
  startedAt: number;
  updatedAt: number;
};

export function initialRuntimeState(
  requestId: string,
  startedAt = Date.now(),
): RuntimeState {
  return {
    requestId,
    threadStatus: "running",
    turnStatus: "in_progress",
    lastSequence: 0,
    startedAt,
    updatedAt: startedAt,
  };
}

export function reduceRuntimeState(
  state: RuntimeState,
  event: AgentEvent,
  sequence = state.lastSequence + 1,
  updatedAt = Date.now(),
): RuntimeState {
  if (sequence <= state.lastSequence) return state;
  return {
    ...state,
    threadStatus: runtimeThreadStatus(event),
    turnStatus: runtimeTurnStatus(event) ?? state.turnStatus,
    lastSequence: sequence,
    updatedAt,
  };
}
