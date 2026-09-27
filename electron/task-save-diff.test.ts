import assert from "node:assert/strict";
import test from "node:test";
import { taskSaveDiff } from "../src/task-save-diff";

test("reports items whose identity changed since the last save", () => {
  const kept = { id: "m1" };
  const activity = { id: "a1" };
  const persisted = { messages: [kept, { id: "m2" }], activities: [activity] };
  const next = {
    messages: [kept, { id: "m2" }, { id: "m3" }],
    activities: [activity],
  };
  assert.deepEqual(taskSaveDiff(persisted, next), {
    changedMessageIds: ["m2", "m3"],
    changedActivityIds: [],
  });
});

test("requests a full save without a persisted baseline", () => {
  assert.deepEqual(taskSaveDiff(undefined, { messages: [{ id: "m1" }] }), {});
});
