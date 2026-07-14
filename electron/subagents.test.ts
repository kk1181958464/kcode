import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../src/types";
import {
  claimSubagentMutation,
  closeSubagentMessageQueue,
  cleanupSubagentRecords,
  drainSubagentMessages,
  listSubagents,
  messageSubagent,
  permissionPolicyForSubagent,
  resetSubagentsForTests,
  setSubagentEventSink,
  spawnSubagent,
  stopSubagent,
  waitForSubagents,
} from "./subagents";

test.afterEach(() => resetSubagentsForTests());

test("preserves confirmation permissions for children", () => {
  assert.equal(permissionPolicyForSubagent("confirm"), undefined);
  assert.deepEqual(
    permissionPolicyForSubagent("confirm", {
      workspaceWrite: "allow",
      deletePaths: "confirm",
      runCommands: "deny",
      longRunningProcesses: "confirm",
      network: "allow",
      gitPublish: "confirm",
    }),
    {
      workspaceWrite: "allow",
      deletePaths: "confirm",
      runCommands: "deny",
      longRunningProcesses: "confirm",
      network: "allow",
      gitPublish: "confirm",
    },
  );
});

test("runs multiple subagents in parallel and aggregates results", async () => {
  const releases = new Map<string, () => void>();
  const runner = async function* (
    _requestId: string,
    agentId: string,
  ): AsyncGenerator<AgentEvent> {
    yield { type: "text", delta: `result:${agentId}` };
    await new Promise<void>((resolve) => releases.set(agentId, resolve));
    yield {
      type: "activity",
      activity: {
        id: `activity:${agentId}`,
        requestId: `request:${agentId}`,
        tool: "read_file",
        status: "success",
        title: "读取文件",
        startedAt: Date.now(),
        completedAt: Date.now(),
        input: { path: "a.ts" },
        path: "a.ts",
        output: "ok",
      },
    };
    yield { type: "usage", input: 10, output: 4, cached: 2 };
    yield { type: "done" };
  };
  const parent = new AbortController();
  const first = spawnSubagent(
    "parent",
    "代码",
    "检查代码",
    parent.signal,
    runner,
  );
  const second = spawnSubagent(
    "parent",
    "测试",
    "检查测试",
    parent.signal,
    runner,
  );
  assert.deepEqual(
    listSubagents("parent").map((agent) => agent.status),
    ["running", "running"],
  );
  while (releases.size < 2)
    await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get(first.id)?.();
  releases.get(second.id)?.();
  const results = await waitForSubagents("parent", [first.id, second.id]);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.ok(results.every((result) => result.usage.input === 10));
  assert.match(results[0].activityRecords[0].title, /^代码 · /);
  const repeated = await waitForSubagents("parent", [first.id]);
  assert.deepEqual(repeated[0].usageDelta, {
    input: 0,
    output: 0,
    cached: 0,
  });
  assert.deepEqual(
    (await cleanupSubagentRecords(["parent"])).sort(),
    [`subagent:${first.id}`, `subagent:${second.id}`].sort(),
  );
  assert.deepEqual(listSubagents("parent"), []);
});

test("queues instructions for the intended running child", async () => {
  let release!: () => void;
  const runner = async function* (): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield { type: "done" };
  };
  const parent = new AbortController();
  const child = spawnSubagent(
    "parent",
    "研究",
    "研究接口",
    parent.signal,
    runner,
  );
  messageSubagent("parent", child.id, "再检查错误处理");
  const listed = listSubagents("parent");
  assert.equal(listed[0].status, "running");
  const requestId = `subagent:${child.id}`;
  assert.deepEqual(drainSubagentMessages(requestId), ["再检查错误处理"]);
  assert.throws(
    () => messageSubagent("other-parent", child.id, "越权消息"),
    /不属于当前任务/,
  );
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await waitForSubagents("parent", [child.id]);
});

test("forwards child permission activities to the root task", async () => {
  const forwarded: AgentEvent[] = [];
  const removeSink = setSubagentEventSink("parent", (event) =>
    forwarded.push(event),
  );
  const runner = async function* (): AsyncGenerator<AgentEvent> {
    yield {
      type: "activity",
      activity: {
        id: "approval",
        requestId: "child",
        tool: "write_file",
        status: "waiting",
        title: "修改文件",
        startedAt: Date.now(),
        input: { path: "a.ts" },
      },
    };
    yield { type: "done" };
  };
  const child = spawnSubagent(
    "parent",
    "代码检查",
    "修改文件",
    new AbortController().signal,
    runner,
  );
  await waitForSubagents("parent", [child.id]);
  removeSink();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].type, "activity");
  if (forwarded[0].type === "activity") {
    assert.equal(forwarded[0].activity.requestId, "parent");
    assert.equal(forwarded[0].activity.subagentId, child.id);
    assert.match(forwarded[0].activity.title, /^代码检查 · /);
  }
});

test("rejects instructions after the child enters its final response", async () => {
  let release!: () => void;
  const runner = async function* (
    requestId: string,
  ): AsyncGenerator<AgentEvent> {
    closeSubagentMessageQueue(requestId);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield { type: "done" };
  };
  const child = spawnSubagent(
    "parent",
    "收尾",
    "返回结果",
    new AbortController().signal,
    runner,
  );
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(
    () => messageSubagent("parent", child.id, "太晚的指令"),
    /正在结束或已经结束/,
  );
  release();
  await waitForSubagents("parent", [child.id]);
});

test("isolates concurrency limits by root task", async () => {
  const runner = async function* (
    _requestId: string,
    _agentId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const firstParent = new AbortController();
  for (let index = 0; index < 8; index += 1)
    spawnSubagent(
      "first",
      `子任务 ${index}`,
      "等待",
      firstParent.signal,
      runner,
    );
  assert.throws(
    () => spawnSubagent("first", "超额", "等待", firstParent.signal, runner),
    /当前任务已有 8 个/,
  );
  const secondParent = new AbortController();
  const independent = spawnSubagent(
    "second",
    "独立任务",
    "等待",
    secondParent.signal,
    runner,
  );
  assert.equal(independent.status, "running");
  firstParent.abort();
  secondParent.abort();
  await Promise.all([
    waitForSubagents("first"),
    waitForSubagents("second", [independent.id]),
  ]);
});

test("prevents sibling subagents from modifying the same path", async () => {
  const runner = async function* (
    _requestId: string,
    _agentId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const parent = new AbortController();
  const first = spawnSubagent(
    "parent",
    "一",
    "修改文件",
    parent.signal,
    runner,
  );
  const second = spawnSubagent(
    "parent",
    "二",
    "修改文件",
    parent.signal,
    runner,
  );
  claimSubagentMutation(`subagent:${first.id}`, "C:\\workspace", ["src/a.ts"]);
  assert.throws(
    () =>
      claimSubagentMutation(`subagent:${second.id}`, "C:\\workspace", [
        "src/a.ts",
      ]),
    /并行修改冲突/,
  );
  parent.abort();
  await waitForSubagents("parent");
});

test("parent cancellation stops a child and stop returns partial output", async () => {
  const runner = async function* (
    _requestId: string,
    _agentId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    yield { type: "text", delta: "partial" };
    if (signal.aborted) return;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const parent = new AbortController();
  const child = spawnSubagent(
    "parent",
    "慢任务",
    "等待",
    parent.signal,
    runner,
  );
  parent.abort();
  const [result] = await waitForSubagents("parent", [child.id]);
  assert.equal(result.status, "stopped");
  assert.equal(result.transcript, "partial");

  const nextParent = new AbortController();
  const next = spawnSubagent(
    "next-parent",
    "可停止",
    "等待",
    nextParent.signal,
    runner,
  );
  const stopped = await stopSubagent("next-parent", next.id);
  assert.equal(stopped.status, "stopped");
});
