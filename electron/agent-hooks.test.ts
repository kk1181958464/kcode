import assert from "node:assert/strict";
import test from "node:test";
import { AgentHookRegistry } from "./agent-hooks";

test("runs hooks in registration order and supports unregister", async () => {
  const registry = new AgentHookRegistry();
  const calls: string[] = [];
  const remove = registry.register("BeforeTool", () => calls.push("first"));
  registry.register("BeforeTool", () => calls.push("second"));
  await registry.run("BeforeTool", { requestId: "r" });
  remove();
  await registry.run("BeforeTool", { requestId: "r" });
  assert.deepEqual(calls, ["first", "second", "second"]);
});
