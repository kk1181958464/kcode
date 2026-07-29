import assert from "node:assert/strict";
import test from "node:test";
import {
  appendActivityOutput,
  getActivityOutput,
  replaceActivityOutput,
  resetActivityOutput,
  subscribeActivityOutput,
} from "../src/activity-output-store";

test("streams activity output independently from React task state", () => {
  const changes: string[] = [];
  const unsubscribe = subscribeActivityOutput("activity-1", (change) =>
    changes.push(change.type),
  );
  appendActivityOutput("activity-1", "hello");
  appendActivityOutput("activity-1", " world");
  assert.equal(getActivityOutput("activity-1"), "hello world");
  replaceActivityOutput("activity-1", "latest");
  assert.equal(getActivityOutput("activity-1"), "latest");
  resetActivityOutput("activity-1");
  assert.equal(getActivityOutput("activity-1"), "");
  assert.deepEqual(changes, ["append", "append", "replace", "reset"]);
  unsubscribe();
});
