import assert from "node:assert/strict";
import test from "node:test";
import {
  initialRuntimeState,
  reduceRuntimeState,
} from "../src/runtime-state-machine";

test("keeps waiting-for-approval distinct from completed", () => {
  let state = initialRuntimeState("request-1", 10);
  state = reduceRuntimeState(
    state,
    {
      type: "activity",
      activity: {
        id: "a",
        requestId: "request-1",
        tool: "write_file",
        status: "waiting",
        title: "write",
        startedAt: 10,
        input: {},
      },
    },
    1,
    20,
  );
  assert.equal(state.threadStatus, "waiting");
  state = reduceRuntimeState(state, { type: "done" }, 2, 30);
  assert.equal(state.threadStatus, "completed");
});

test("ignores an older event arriving after a newer one", () => {
  const state = initialRuntimeState("request-1");
  const newer = reduceRuntimeState(
    state,
    { type: "progress", message: "b" },
    4,
  );
  const older = reduceRuntimeState(newer, { type: "error", message: "old" }, 3);
  assert.equal(older.threadStatus, "running");
  assert.equal(older.lastSequence, 4);
});

test("records a user cancellation as interrupted instead of failed", () => {
  const state = reduceRuntimeState(
    initialRuntimeState("request-1"),
    { type: "error", message: "任务已停止", code: "cancelled" },
    1,
  );
  assert.equal(state.threadStatus, "interrupted");
  assert.equal(state.turnStatus, "interrupted");
});
