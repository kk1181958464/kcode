import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKPOINT_EVENT_LIMIT,
  appendCheckpointEvent,
} from "./checkpoint-events";
import type { AgentActivity, AgentEvent } from "../src/types";

test("merges streaming deltas so activities stay in the checkpoint window", () => {
  const events: AgentEvent[] = [];
  const activity = { id: "a1", requestId: "r1" } as AgentActivity;
  appendCheckpointEvent(events, { type: "activity", activity });
  for (let index = 0; index < CHECKPOINT_EVENT_LIMIT * 3; index++)
    appendCheckpointEvent(events, { type: "text", delta: "x" });
  for (let index = 0; index < CHECKPOINT_EVENT_LIMIT * 3; index++)
    appendCheckpointEvent(events, { type: "progress", message: `p${index}` });
  appendCheckpointEvent(events, { type: "reasoning", delta: "a" });
  appendCheckpointEvent(events, { type: "reasoning", delta: "b" });
  assert.equal(events[0].type, "activity");
  assert.ok(events.length < CHECKPOINT_EVENT_LIMIT);
  assert.deepEqual(events.at(-1), { type: "reasoning", delta: "ab" });
});

test("keeps separate text runs across other events and bounds the window", () => {
  const events: AgentEvent[] = [];
  appendCheckpointEvent(events, { type: "text", delta: "a" });
  appendCheckpointEvent(events, { type: "text", delta: "b" });
  appendCheckpointEvent(events, { type: "done" } as AgentEvent);
  appendCheckpointEvent(events, { type: "text", delta: "c" });
  assert.deepEqual(
    events.map((event) => (event.type === "text" ? event.delta : event.type)),
    ["ab", "done", "c"],
  );
  for (let index = 0; index < CHECKPOINT_EVENT_LIMIT * 2; index++)
    appendCheckpointEvent(events, { type: "done" } as AgentEvent);
  assert.equal(events.length, CHECKPOINT_EVENT_LIMIT);
});
