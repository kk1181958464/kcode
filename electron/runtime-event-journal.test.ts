import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../src/types";
import { RuntimeEventJournal } from "./runtime-event-journal";
import { isAgentEventEnvelope } from "../src/runtime-protocol";

test("assigns stable request-local event identities and preserves order", () => {
  const batches: string[][] = [];
  const journal = new RuntimeEventJournal("task-1", "request-1", (events) =>
    batches.push(events.map((event) => event.eventId)),
  );

  const first = journal.append({ type: "text", delta: "a" });
  const second = journal.append({ type: "progress", message: "working" });
  const third = journal.append({ type: "done" });
  journal.close();

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(third.sequence, 3);
  assert.deepEqual(batches.flat(), [
    "request-1:1",
    "request-1:2",
    "request-1:3",
  ]);
  assert.equal(first.taskId, "task-1");
  assert.equal(first.protocolVersion, 1);
  assert.equal(first.itemId, "request-1:assistant-message");
  assert.equal(journal.lastSequence, 3);
  assert.equal(isAgentEventEnvelope(first), true);
  assert.equal(isAgentEventEnvelope({ ...first, sequence: 0 }), false);
});

test("flushes buffered stream events when closed", () => {
  const persisted: AgentEvent[] = [];
  const journal = new RuntimeEventJournal("task-1", "request-1", (events) =>
    persisted.push(...events),
  );
  journal.append({ type: "text", delta: "hello" });
  journal.append({ type: "reasoning", delta: "plan" });
  assert.equal(persisted.length, 0);
  journal.close();
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].itemId, "request-1:assistant-message");
  assert.equal(persisted[1].itemId, "request-1:reasoning");
});

test("keeps activity output on the same runtime item", () => {
  const persisted: AgentEvent[] = [];
  const journal = new RuntimeEventJournal("task-1", "request-1", (events) =>
    persisted.push(...events),
  );
  const activity = journal.append({
    type: "activity",
    activity: {
      id: "activity-1",
      requestId: "request-1",
      tool: "run_command",
      status: "running",
      title: "run",
      startedAt: 10,
      input: {},
    },
  });
  const output = journal.append({
    type: "activity_output",
    activityId: "activity-1",
    mode: "append",
    value: "working",
  });
  journal.close();
  assert.equal(activity.itemId, "activity-1");
  assert.equal(output.itemId, "activity-1");
});
