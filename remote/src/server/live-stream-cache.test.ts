import assert from "node:assert/strict";
import test from "node:test";
import { LiveStreamCache, type LiveStreamEvent } from "./live-stream-cache.js";

function stream(
  content: string,
  updatedAt: number,
  requestId = "request-1",
  sequence = updatedAt,
): LiveStreamEvent {
  return {
    type: "task.event",
    event: "stream",
    taskId: "task-1",
    requestId,
    sequence,
    content,
    updatedAt,
  };
}

test("retains the latest live output for reconnecting mobile clients", () => {
  const cache = new LiveStreamCache();
  cache.update("user-1", "device-1", stream("new", 200), 200);
  cache.update("user-1", "device-1", stream("stale", 100), 201);

  assert.deepEqual(cache.list("user-1", "device-1", 202), [
    { deviceId: "device-1", ...stream("new", 200) },
  ]);
  assert.equal(cache.list("another-user", undefined, 202).length, 0);
});

test("rejects a delayed stream snapshot by sequence even with a newer clock", () => {
  const cache = new LiveStreamCache();
  cache.update("user-1", "device-1", stream("latest", 100, "request-1", 3));
  cache.update("user-1", "device-1", stream("late", 200, "request-1", 2));
  assert.equal(cache.list("user-1", "device-1", 201)[0].content, "latest");
});

test("clears output after a matching task snapshot finishes", () => {
  const cache = new LiveStreamCache();
  cache.update("user-1", "device-1", stream("working", 200), 200);

  cache.reconcile(
    "user-1",
    "device-1",
    [{ id: "task-1", runningId: "request-1", updatedAt: 150 }],
    201,
  );
  assert.equal(cache.list("user-1", "device-1", 202).length, 1);

  cache.reconcile(
    "user-1",
    "device-1",
    [{ id: "task-1", updatedAt: 250 }],
    203,
  );
  assert.equal(cache.list("user-1", "device-1", 204).length, 0);
});

test("does not let an older snapshot erase newer stream output", () => {
  const cache = new LiveStreamCache();
  cache.update("user-1", "device-1", stream("working", 300), 300);
  cache.reconcile(
    "user-1",
    "device-1",
    [{ id: "task-1", updatedAt: 200 }],
    301,
  );
  assert.equal(cache.list("user-1", "device-1", 302).length, 1);
});

test("bounds retained output by age and entry count", () => {
  const cache = new LiveStreamCache(2, 10);
  cache.update("user-1", "device-1", stream("one", 1), 1);
  cache.update(
    "user-1",
    "device-1",
    { ...stream("two", 2), taskId: "task-2" },
    2,
  );
  cache.update(
    "user-1",
    "device-1",
    { ...stream("three", 3), taskId: "task-3" },
    3,
  );
  assert.deepEqual(
    cache.list("user-1", "device-1", 4).map((item) => item.taskId),
    ["task-2", "task-3"],
  );
  assert.equal(cache.list("user-1", "device-1", 20).length, 0);
});
