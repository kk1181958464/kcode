import assert from "node:assert/strict";
import test from "node:test";
import { TaskRuntimeStore } from "../src/task-runtime-store";
import type { AgentEvent } from "../src/types";

function waitingEvent(sequence: number): AgentEvent {
  return {
    type: "activity",
    sequence,
    activity: {
      id: "approval-a",
      requestId: "request-a",
      tool: "write_file",
      status: "waiting",
      title: "等待写入批准",
      startedAt: 10,
      input: {},
    },
  };
}

test("tracks streaming events without notifying lifecycle subscribers", () => {
  const store = new TaskRuntimeStore();
  store.start("task-a", "request-a", 10);
  const revision = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  const deltas: AgentEvent[] = [
    { type: "text", delta: "token" },
    { type: "reasoning", delta: "reason" },
    { type: "progress", message: "正在执行" },
    {
      type: "activity_output",
      activityId: "tool-a",
      mode: "append",
      value: "output",
    },
  ];
  for (let sequence = 1; sequence <= 1_000; sequence++) {
    store.applyEvent("task-a", "request-a", {
      ...deltas[(sequence - 1) % deltas.length],
      sequence,
      emittedAt: 10 + sequence,
    });
  }

  assert.equal(notifications, 0);
  assert.equal(store.getSnapshot(), revision);
  assert.equal(store.get("task-a")?.state.lastSequence, 1_000);
  assert.equal(store.get("task-a")?.state.updatedAt, 1_010);

  // Suppressed notifications must not let an older approval event win.
  store.applyEvent("task-a", "request-a", waitingEvent(999));
  assert.equal(store.get("task-a")?.state.threadStatus, "running");
  assert.equal(notifications, 0);
});

test("notifies approval, resume, and completion transitions during streaming", () => {
  const store = new TaskRuntimeStore();
  store.start("task-a", "request-a", 10);
  const observed: string[] = [];
  store.subscribe(() => {
    const state = store.get("task-a")!.state;
    observed.push(`${state.threadStatus}:${state.turnStatus}`);
  });

  store.applyEvent("task-a", "request-a", waitingEvent(1));
  store.applyEvent("task-a", "request-a", waitingEvent(2));
  store.applyEvent("task-a", "request-a", {
    type: "text",
    delta: "继续",
    sequence: 3,
  });
  store.applyEvent("task-a", "request-a", {
    type: "reasoning",
    delta: "分析",
    sequence: 4,
  });
  store.applyEvent("task-a", "request-a", { type: "done", sequence: 5 });

  assert.deepEqual(observed, [
    "waiting:in_progress",
    "running:in_progress",
    "completed:completed",
  ]);
});

test("publishes turn completion even when the thread is still waiting", () => {
  const store = new TaskRuntimeStore();
  store.start("task-a", "request-a", 10);
  store.applyEvent("task-a", "request-a", waitingEvent(1));
  let notifications = 0;
  store.subscribe(() => notifications++);

  store.applyEvent("task-a", "request-a", {
    type: "done",
    outcome: "blocked",
    sequence: 2,
  });

  assert.equal(notifications, 1);
  assert.equal(store.get("task-a")?.state.threadStatus, "waiting");
  assert.equal(store.get("task-a")?.state.turnStatus, "completed");
});

test("announces discovered runs and preserves another task on finish", () => {
  const store = new TaskRuntimeStore();
  store.start("task-b", "request-b", 20);
  const observed: (string | undefined)[] = [];
  store.subscribe(() => observed.push(store.get("task-a")?.requestId));

  store.applyEvent("task-a", "request-a", {
    type: "text",
    delta: "后台输出",
    sequence: 1,
  });
  store.applyEvent("task-a", "request-a", {
    type: "text",
    delta: "更多输出",
    sequence: 2,
  });
  store.start("task-a", "request-new", 30);
  assert.equal(store.finish("task-a", "request-a"), false);
  assert.equal(store.finish("task-a", "request-new"), true);

  assert.deepEqual(observed, ["request-a", "request-new", undefined]);
  assert.equal(store.get("task-b")?.requestId, "request-b");
});

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
