import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, ModelRequest } from "../src/types";
import { runAgent, type RunAgentDeps } from "./agent";

function fakeProvider(): RunAgentDeps["getProvider"] {
  return async () =>
    ({
      id: "fake",
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://example.invalid",
      enabled: true,
      models: [
        {
          id: "fake-model",
          modelId: "fake-model",
          displayName: "fake-model",
          protocol: "openai-chat",
        },
      ],
      apiKey: "sk-fake",
      apiKeys: ["sk-fake"],
    }) as never;
}

test("asks the model to change strategy before pausing repeated tool rounds", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "kcode-stall-"));
  await writeFile(path.join(workspacePath, "unchanged.txt"), "same\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "检查 unchanged.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let recoveryInstructionSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "stall-policy-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        recoveryInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_stall_recovery>"),
        );
        yield {
          type: "complete",
          turn: {
            text: "",
            calls: [
              {
                id: `same-call-${rounds}`,
                name: "path_info",
                input: { path: "unchanged.txt" },
              },
            ],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.equal(rounds, 6);
  assert.equal(recoveryInstructionSeen, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("更换执行策略"),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "text" && event.delta.includes("连续 5 轮"),
    ),
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.ok(
    events.some((event) => event.type === "done" && event.outcome === "paused"),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "incomplete");
});

test("finalizes repeated post-change checks from structured evidence", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "kcode-closing-"));
  await writeFile(
    path.join(workspacePath, "first.js"),
    'const value = "first";\n',
    "utf8",
  );
  await writeFile(path.join(workspacePath, "second.txt"), "second\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "把 first.js 改成 changed 并验证" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let finalizationInstructionSeen = false;
  let finalizationDisabledTools = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "closing-policy-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        finalizationInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("操作证据已经完整"),
        );
        if (rounds === 4) {
          finalizationDisabledTools = !args.toolsEnabled;
          yield {
            type: "complete",
            turn: {
              text: "结论：文件已经修改并完成验证。",
              calls: [],
              rawCalls: [],
              usage: { input: 20, output: 8, cached: 0 },
            },
          };
          return;
        }
        const calls =
          rounds === 1
            ? [
                {
                  id: "inspect",
                  name: "read_file" as const,
                  input: { path: "first.js" },
                },
                {
                  id: "modify",
                  name: "write_file" as const,
                  input: {
                    path: "first.js",
                    content: 'const value = "changed";\n',
                  },
                },
                {
                  id: "validate",
                  name: "run_command" as const,
                  input: { command: "node --check first.js" },
                },
              ]
            : [
                {
                  id: `closing-call-${rounds}`,
                  name: "path_info" as const,
                  input: { path: rounds === 2 ? "first.js" : "second.txt" },
                },
              ];
        yield {
          type: "complete",
          turn: {
            text: "继续核对结构化工具结果。",
            calls,
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.equal(rounds, 4);
  assert.equal(finalizationInstructionSeen, true);
  assert.equal(finalizationDisabledTools, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("停止继续检查"),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "done" && event.outcome === "completed",
    ),
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("stops varied checks after a completed plan even when mutation evidence is missing", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-post-plan-stall-"),
  );
  await writeFile(path.join(workspacePath, "first.txt"), "first\n", "utf8");
  await writeFile(path.join(workspacePath, "second.txt"), "second\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "修改文件并验证" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let finalizationDisabledTools = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "post-plan-stall-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        if (rounds === 4) {
          finalizationDisabledTools = !args.toolsEnabled;
          throw new Error(
            "模型收尾阶段持续只有思考内容，未返回正文或工具调用。",
          );
        }
        const calls =
          rounds === 1
            ? [
                {
                  id: "failed-modification",
                  name: "apply_patch" as const,
                  input: { patch: "not a patch" },
                },
                {
                  id: "completed-plan",
                  name: "update_plan" as const,
                  input: {
                    plan: [
                      { step: "修改目标", status: "completed" },
                      { step: "验证结果", status: "completed" },
                    ],
                  },
                },
              ]
            : [
                {
                  id: `different-check-${rounds}`,
                  name: "path_info" as const,
                  input: {
                    path: rounds === 2 ? "first.txt" : "second.txt",
                  },
                },
              ];
        yield {
          type: "complete",
          turn: {
            text: "继续核对。",
            calls,
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.equal(rounds, 4);
  assert.equal(finalizationDisabledTools, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "text" && event.delta.includes("停止继续调用工具"),
    ),
  );
  assert.ok(
    events.some((event) => event.type === "done" && event.outcome === "paused"),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "incomplete");
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});
