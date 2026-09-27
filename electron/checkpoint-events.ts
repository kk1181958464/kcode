import type { AgentEvent } from "../src/types";

export const CHECKPOINT_EVENT_LIMIT = 100;
const MAX_MERGED_TEXT_CHARS = 12_000;

/**
 * Append an event to the bounded crash-checkpoint window. Streaming deltas are
 * merged into the previous event of the same kind; otherwise token-sized text
 * events would push activity rows (which recovery reads) out of the window.
 */
export function appendCheckpointEvent(events: AgentEvent[], item: AgentEvent) {
  const last = events.at(-1);
  if (
    (item.type === "text" &&
      last?.type === "text" &&
      last.phase === item.phase) ||
    (item.type === "reasoning" && last?.type === "reasoning")
  ) {
    events[events.length - 1] = {
      ...last,
      delta: `${last.delta}${item.delta}`.slice(-MAX_MERGED_TEXT_CHARS),
    } as AgentEvent;
    return;
  }
  if (item.type === "progress" && last?.type === "progress") {
    events[events.length - 1] = item;
    return;
  }
  events.push(item);
  if (events.length > CHECKPOINT_EVENT_LIMIT) events.shift();
}
