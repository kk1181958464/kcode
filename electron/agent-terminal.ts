import type { AgentEvent } from "../src/types";
import type { RunState } from "./agent-run-state";
import { closeSubagentMessageQueue } from "./subagents";
import { turnSteeringQueue } from "./turn-steering";

/** Return false when accepted steering needs another model round. */
export function* emitAgentTerminalEvents(
  requestId: string,
  signal: AbortSignal,
  run: Pick<RunState, "timelineTextLength">,
  events: readonly AgentEvent[],
): Generator<AgentEvent, boolean> {
  for (const event of events) {
    if (signal.aborted) {
      turnSteeringQueue.clear(requestId);
      closeSubagentMessageQueue(requestId);
      yield { type: "error", message: "任务已停止" };
      return true;
    }
    if (turnSteeringQueue.size(requestId)) return false;
    if (event.type === "done" || event.type === "error") {
      // No await/yield between the pending check and closing acceptance.
      turnSteeringQueue.clear(requestId);
      closeSubagentMessageQueue(requestId);
    }
    if (event.type === "text") run.timelineTextLength += event.delta.length;
    yield event;
  }
  return true;
}
