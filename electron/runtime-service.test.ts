import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeService } from "./runtime-service";
import { RuntimeEventJournal } from "./runtime-event-journal";

test("keeps runtime status after the selected task changes", () => {
  const service = new AgentRuntimeService();
  service.start("task-a", "request-a", 10);
  service.start("task-b", "request-b", 20);
  service.apply("task-a", "request-a", {
    type: "progress",
    message: "仍在执行",
    sequence: 1,
  });
  assert.equal(service.active("task-a")[0]?.requestId, "request-a");
  assert.equal(service.active("task-b")[0]?.requestId, "request-b");
});

test("terminal events close only their own run", () => {
  const service = new AgentRuntimeService();
  service.start("task-a", "request-a");
  service.start("task-a", "request-b");
  service.apply("task-a", "request-a", { type: "done" });
  assert.deepEqual(
    service.active("task-a").map((run) => run.requestId),
    ["request-b"],
  );
});

test("restores durable runtime snapshots and keeps interrupted runs inactive", () => {
  const service = new AgentRuntimeService();
  service.restore([
    {
      taskId: "task-a",
      requestId: "request-a",
      status: "running",
      turnStatus: "in_progress",
      lastSequence: 4,
      updatedAt: 40,
    },
    {
      taskId: "task-b",
      requestId: "request-b",
      status: "interrupted",
      turnStatus: "interrupted",
      lastSequence: 8,
      updatedAt: 80,
    },
  ]);
  assert.deepEqual(
    service.active().map((run) => run.requestId),
    ["request-a"],
  );
  assert.equal(service.list().find((run) => run.requestId === "request-b")?.active, false);
  assert.equal(service.list().find((run) => run.requestId === "request-a")?.lastSequence, 4);
});

test("projects journal events into the runtime service in sequence order", () => {
  const service = new AgentRuntimeService();
  service.start("task-a", "request-a", 10);
  const journal = new RuntimeEventJournal("task-a", "request-a", (events) => {
    for (const event of events)
      service.apply("task-a", "request-a", event);
  }, 0);

  journal.append({ type: "progress", message: "working" }, 20);
  journal.append({ type: "done", outcome: "completed" }, 30);
  journal.close();

  const run = service.list("task-a")[0];
  assert.equal(run?.lastSequence, 2);
  assert.equal(run?.threadStatus, "completed");
  assert.equal(run?.turnStatus, "completed");
  assert.equal(run?.active, false);
});

test("ignores stale events after a run reaches a terminal state", () => {
  const service = new AgentRuntimeService();
  service.start("task-a", "request-a");
  service.apply("task-a", "request-a", { type: "done", sequence: 2 });
  service.apply("task-a", "request-a", {
    type: "progress",
    message: "stale",
    sequence: 1,
  });
  const run = service.list("task-a")[0];
  assert.equal(run?.lastSequence, 2);
  assert.equal(run?.threadStatus, "completed");
  assert.equal(run?.active, false);
});
