import assert from "node:assert/strict";
import test from "node:test";
import { TaskRuntimeStore } from "../src/task-runtime-store";

test("keeps a newer task request when an older completion arrives", () => {
  const store = new TaskRuntimeStore();
  store.start("task-a", "request-a", 10);
  store.start("task-b", "request-b", 20);

  assert.equal(store.finish("task-a", "request-a"), true);
  assert.equal(store.get("task-b")?.requestId, "request-b");
  assert.equal(store.finish("task-b", "request-old"), false);
  assert.equal(store.get("task-b")?.requestId, "request-b");
  assert.equal(store.finish("task-b", "request-b"), true);
  assert.equal(store.get("task-b"), undefined);
});

test("overlays only the sidebar-visible runtime fields", () => {
  const store = new TaskRuntimeStore();
  store.start("task-a", "request-a", 42);
  const task = {
    id: "task-a",
    name: "测试任务",
    workspacePath: "D:/workspace",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    activities: [],
    runStatus: "idle" as const,
  };

  const [overlay] = store.overlayTasks([task]);
  assert.equal(overlay.runningId, "request-a");
  assert.equal(overlay.runStatus, "running");
  assert.equal(overlay.startedAt, 42);
  assert.equal(overlay.messages, task.messages);
});

