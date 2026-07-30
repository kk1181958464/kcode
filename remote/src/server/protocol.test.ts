import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteCommand, parseTaskSnapshots } from "./protocol.js";

test("accepts only the supported remote control commands", () => {
  assert.deepEqual(
    parseRemoteCommand({ type: "task.load", taskId: "task-1" }),
    { type: "task.load", taskId: "task-1" },
  );
  assert.deepEqual(
    parseRemoteCommand({
      type: "task.send",
      taskId: "task-1",
      content: "继续",
    }),
    { type: "task.send", taskId: "task-1", content: "继续" },
  );
  assert.throws(() =>
    parseRemoteCommand({ type: "run_command", taskId: "task-1" }),
  );
});

test("bounds and validates task snapshots", () => {
  const task = {
    id: "task-1",
    name: "测试任务",
    workspaceName: "kcode",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    activities: [],
  };
  assert.deepEqual(parseTaskSnapshots([task]), [task]);
  assert.throws(() => parseTaskSnapshots([{ id: "bad" }]));
});
