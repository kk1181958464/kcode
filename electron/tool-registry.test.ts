import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "./tool-registry";

test("records a typed tool lifecycle independently from UI activities", () => {
  const registry = new ToolRegistry();
  const events: string[] = [];
  registry.subscribe((event) => events.push(event.type));
  const trace = registry.start({
    requestId: "request-1",
    activityId: "activity-1",
    tool: "run_command",
    args: { command: "npm test" },
  });
  registry.progress(trace.callId, "running");
  registry.finish(trace.callId);
  assert.equal(trace.callId.length > 10, true);
  assert.deepEqual(events, ["started", "progress", "completed"]);
  assert.equal(registry.active().length, 0);
});

test("keeps approval state explicit", () => {
  const registry = new ToolRegistry();
  const events: string[] = [];
  registry.subscribe((event) => events.push(event.type));
  const trace = registry.start({
    requestId: "request-1",
    activityId: "activity-1",
    tool: "write_file",
    args: {},
  });
  registry.markWaiting(trace.callId);
  assert.equal(registry.active("request-1")[0]?.status, "waiting");
  registry.markRunning(trace.callId);
  registry.finish(trace.callId, "denied");
  assert.deepEqual(events, ["started", "status", "status", "failed"]);
  assert.equal(registry.active().length, 0);
});
