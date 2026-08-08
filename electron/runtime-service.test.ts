import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeService } from "./runtime-service";

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
