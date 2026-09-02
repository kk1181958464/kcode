import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, ModelRequest } from "../src/types";
import { runAgent, type RunAgentDeps } from "./agent";
import {
  listSubagents,
  resetSubagentsForTests,
  spawnSubagent,
} from "./subagents";

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

test("finalizes repeated read-only checks even while the plan remains active", async () => {
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
  let finalizationInstructionSeen = false;
  let finalTurnToolsEnabled = true;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "stall-policy-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        finalizationInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes('reason="repeated_tool_results"'),
        );
        if (!args.toolsEnabled) {
          finalTurnToolsEnabled = false;
          yield {
            type: "complete",
            turn: {
              text: "结论：文件内容已读取，现有记录可以直接汇总。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        const calls =
          rounds === 1
            ? [
                {
                  id: "active-plan",
                  name: "update_plan" as const,
                  input: {
                    plan: [
                      {
                        step: "读取文件",
                        status: "completed",
                        requires: ["inspect"],
                      },
                      { step: "汇总结论", status: "in_progress", requires: [] },
                    ],
                  },
                },
                {
                  id: "initial-read",
                  name: "read_file" as const,
                  input: { path: "unchanged.txt" },
                },
              ]
            : rounds % 2 === 0
              ? [
                  {
                    id: `repeat-read-${rounds}`,
                    name: "read_file" as const,
                    input: { path: "unchanged.txt" },
                  },
                ]
              : [
                  {
                    id: `repeat-info-${rounds}`,
                    name: "path_info" as const,
                    input: { path: "unchanged.txt" },
                  },
                ];
        yield {
          type: "complete",
          turn: {
            text: "我再确认一次文件内容，然后给出结论。",
            calls,
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.ok(
    rounds <= 6,
    `expected bounded finalization, received ${rounds} rounds`,
  );
  assert.equal(finalizationInstructionSeen, true);
  assert.equal(finalTurnToolsEnabled, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("生成最终结论"),
    ),
  );
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.ok(
    events.some(
      (event) => event.type === "done" && event.outcome === "completed",
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.notEqual(done?.result?.kind, "incomplete");
});

test("stops a child that remains active without observable progress", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-subagent-stall-"),
  );
  const requestId = "subagent-stall-integration";
  const childController = new AbortController();
  const child = spawnSubagent(
    requestId,
    "无进展审查",
    "保持等待",
    childController.signal,
    async function* (_requestId, _agentId, signal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "汇总子任务结果" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  const events: AgentEvent[] = [];
  let childState: ReturnType<typeof listSubagents>[number] | undefined;
  try {
    for await (const event of runAgent(
      requestId,
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider(),
        async *streamTurn(args) {
          rounds += 1;
          if (!args.toolsEnabled) {
            yield {
              type: "complete",
              turn: {
                text: "已汇总已收到的结果，未完成的子任务已停止。",
                calls: [],
                rawCalls: [],
                usage: { input: 1, output: 1, cached: 0 },
              },
            };
            return;
          }
          yield {
            type: "complete",
            turn: {
              text: "继续检查子任务状态。",
              calls: [
                {
                  id: `list-${rounds}`,
                  name: "list_agents",
                  input: {},
                },
              ],
              rawCalls: [],
              usage: { input: 1, output: 1, cached: 0 },
            },
          };
        },
      },
    ))
      events.push(event);
    childState = listSubagents(requestId)[0];
  } finally {
    childController.abort();
    await resetSubagentsForTests();
  }

  assert.equal(rounds, 5, "four stalled rounds plus one finalization turn");
  assert.equal(childState?.id, child.id);
  assert.equal(childState?.status, "stopped");
  assert.equal(childState?.collected, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" &&
        event.message.includes("没有新进展") &&
        event.message.includes("停止未完成"),
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "paused");
  assert.equal(done?.result?.kind, "incomplete");
});

test("bounds changing read-only output instead of treating it as progress forever", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-semantic-stall-"),
  );
  await writeFile(
    path.join(workspacePath, "probe.txt"),
    Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
    "utf8",
  );
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "检查 probe.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let finalizationInstructionSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "semantic-stall-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        finalizationInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes('reason="repeated_tool_results"'),
        );
        if (!args.toolsEnabled)
          throw new Error(
            "模型收尾阶段持续只有思考内容，未返回正文或工具调用。",
          );
        yield {
          type: "complete",
          turn: {
            text: "继续读取下一行进行核对。",
            calls: [
              {
                id: `changing-read-${rounds}`,
                name: "read_file",
                input: {
                  path: "probe.txt",
                  startLine: rounds,
                  endLine: rounds,
                },
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

  assert.equal(rounds, 11, "ten semantic stalls plus one finalization turn");
  assert.equal(finalizationInstructionSeen, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" &&
        event.message.includes("没有产生实际状态变化"),
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.notEqual(done?.result?.kind, "incomplete");
});

test("does not execute stale tool calls after entering finalization", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-finalization-tool-"),
  );
  const protectedPath = path.join(workspacePath, "protected.txt");
  await writeFile(
    protectedPath,
    Array.from({ length: 12 }, (_, index) => `keep-${index + 1}`).join("\n"),
    "utf8",
  );
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "检查 protected.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "finalization-tool-boundary",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        if (rounds > 12) throw new Error("finalization loop reopened");
        if (!args.toolsEnabled) {
          finalizationSeen = true;
          yield {
            type: "complete",
            turn: {
              text: "",
              calls: [
                {
                  id: "stale-finalization-write",
                  name: "write_file",
                  input: {
                    file_path: "protected.txt",
                    content: "must-not-write\n",
                  },
                },
              ],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "继续核对。",
            calls: [
              {
                id: `boundary-read-${rounds}`,
                name: "read_file",
                input: {
                  path: "protected.txt",
                  startLine: rounds,
                  endLine: rounds,
                },
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

  assert.equal(finalizationSeen, true);
  assert.equal(
    await readFile(protectedPath, "utf8"),
    "keep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nkeep-7\nkeep-8\nkeep-9\nkeep-10\nkeep-11\nkeep-12",
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "activity" && event.activity.tool === "write_file",
    ),
    false,
  );
  assert.ok(
    events.some(
      (event) => event.type === "progress" && event.message.includes("忽略"),
    ),
  );
  assert.equal(
    events.some(
      (event) => event.type === "done" && event.outcome === "completed",
    ),
    true,
  );
});

test("marks a reasoning-only finalization fallback as paused", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-finalization-fallback-"),
  );
  await writeFile(
    path.join(workspacePath, "probe.txt"),
    Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
    "utf8",
  );
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "修改并检查 probe.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "finalization-fallback-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        if (!args.toolsEnabled)
          throw new Error(
            "模型收尾阶段持续只有思考内容，未返回正文或工具调用。",
          );
        const calls =
          rounds === 1
            ? [
                {
                  id: "failed-mutation-before-fallback",
                  name: "apply_patch" as const,
                  input: { patch: "not a patch" },
                },
              ]
            : [
                {
                  id: `fallback-read-${rounds}`,
                  name: "read_file" as const,
                  input: {
                    path: "probe.txt",
                    startLine: rounds,
                    endLine: rounds,
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

  assert.equal(rounds, 11);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "paused");
  assert.equal(done?.result?.kind, "incomplete");
  assert.match(done?.result?.notice ?? "", /没有返回最终正文/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "text" && event.delta.includes("本轮已安全暂停"),
    ),
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "text" && event.delta.includes("最近一次成功结果"),
    ),
    false,
  );
});

test("finalizes a completed plan after repeated post-change checks", async () => {
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
  let recoveryInstructionSeen = false;
  let finalizationInstructionSeen = false;
  let finalTurnToolsEnabled = true;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "closing-policy-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        recoveryInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_repetition_recovery>"),
        );
        finalizationInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_finalization>"),
        );
        if (!args.toolsEnabled) {
          finalTurnToolsEnabled = args.toolsEnabled;
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
                  input: {
                    path: rounds % 2 === 0 ? "first.js" : "second.txt",
                  },
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
  assert.equal(recoveryInstructionSeen, false);
  assert.equal(finalizationInstructionSeen, true);
  assert.equal(finalTurnToolsEnabled, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("生成最终结论"),
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

test("reopens execution after a completed plan lacks mutation evidence", async () => {
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
  let recoveryInstructionSeen = false;
  let toolsDisabled = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "post-plan-stall-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        toolsDisabled ||= !args.toolsEnabled;
        recoveryInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_repetition_recovery>"),
        );
        if (rounds === 6) {
          yield {
            type: "complete",
            turn: {
              text: "结论：遗漏的修改已经实际完成。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
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
                      {
                        step: "修改目标",
                        status: "completed",
                        requires: ["modify"],
                      },
                      { step: "整理结果", status: "completed", requires: [] },
                    ],
                  },
                },
              ]
            : rounds === 5
              ? [
                  {
                    id: "recovered-modification",
                    name: "write_file" as const,
                    input: { path: "first.txt", content: "changed\n" },
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

  assert.equal(rounds, 6);
  assert.equal(recoveryInstructionSeen, true);
  assert.equal(toolsDisabled, false);
  assert.equal(
    await readFile(path.join(workspacePath, "first.txt"), "utf8"),
    "changed\n",
  );
  assert.ok(
    events.some(
      (event) => event.type === "done" && event.outcome === "completed",
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "changed");
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("does not finish a required plan step from prose without tool evidence", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-plan-evidence-"),
  );
  await writeFile(path.join(workspacePath, "target.txt"), "before\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "修改 target.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let recoveryInstructionSeen = false;
  let wrote = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "plan-evidence-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        recoveryInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_execution_recovery>"),
        );
        if (wrote) {
          yield {
            type: "complete",
            turn: {
              text: "已根据实际工具结果完成修改。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        const calls =
          rounds === 1
            ? [
                {
                  id: "plan-with-obligation",
                  name: "update_plan" as const,
                  input: {
                    plan: [
                      {
                        step: "修改目标文件",
                        status: "completed",
                        requires: ["modify"],
                      },
                      { step: "整理结果", status: "completed", requires: [] },
                    ],
                  },
                },
                {
                  id: "initial-check",
                  name: "read_file" as const,
                  input: { path: "target.txt" },
                },
              ]
            : recoveryInstructionSeen
              ? [
                  {
                    id: "real-modification",
                    name: "write_file" as const,
                    input: { path: "target.txt", content: "after\n" },
                  },
                ]
              : [
                  {
                    id: `repeat-check-${rounds}`,
                    name: "path_info" as const,
                    input: {
                      path: rounds % 2 === 0 ? "target.txt" : "missing.txt",
                    },
                  },
                ];
        if (recoveryInstructionSeen) wrote = true;
        yield {
          type: "complete",
          turn: {
            text: "我再检查一下。",
            calls,
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.equal(recoveryInstructionSeen, true);
  assert.equal(
    await readFile(path.join(workspacePath, "target.txt"), "utf8"),
    "after\n",
  );
  assert.ok(rounds <= 12, `expected bounded recovery, received ${rounds}`);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("真实执行结果"),
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.equal(done?.result?.kind, "changed");
});

test("resumed structured plans execute missing evidence even when old status says completed", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-recovery-plan-start-"),
  );
  await writeFile(path.join(workspacePath, "target.txt"), "before\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "继续完成 target.txt 的修改" }],
    permissionMode: "full-access",
    workspacePath,
    recoveryPlan: {
      steps: [
        {
          step: "修改目标文件",
          status: "completed",
          requires: ["modify"],
        },
      ],
      current: 0,
      requirementsDeclared: true,
    },
  };
  let rounds = 0;
  let recoveryInstructionSeen = false;
  let wrote = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "recovery-plan-start-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        recoveryInstructionSeen ||= args.history.some(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_verification>"),
        );
        if (wrote) {
          yield {
            type: "complete",
            turn: {
              text: "已根据实际工具结果完成修改。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        if (recoveryInstructionSeen) {
          wrote = true;
          yield {
            type: "complete",
            turn: {
              text: "现在执行缺少的修改。",
              calls: [
                {
                  id: "recovered-write",
                  name: "write_file" as const,
                  input: { path: "target.txt", content: "after\n" },
                },
              ],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "旧计划已经完成，我先整理结果。",
            calls: [],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.equal(recoveryInstructionSeen, true);
  assert.equal(
    await readFile(path.join(workspacePath, "target.txt"), "utf8"),
    "after\n",
  );
  assert.ok(rounds <= 6, `expected bounded resume, received ${rounds} rounds`);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.equal(done?.result?.kind, "changed");
});

test("keeps executing after a successful build resets semantic stall state", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-operational-progress-"),
  );
  await writeFile(path.join(workspacePath, "target.txt"), "before\n", "utf8");
  for (let index = 0; index < 16; index += 1)
    await writeFile(
      path.join(workspacePath, `check-${index}.txt`),
      "same\n",
      "utf8",
    );

  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "构建并部署 target.txt" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let recoveryCount = 0;
  let buildSeen = false;
  let finished = false;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "operational-progress-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        recoveryCount = args.history.filter(
          (item) =>
            item.kind === "message" &&
            item.content.includes("<runtime_repetition_recovery>"),
        ).length;
        if (!args.toolsEnabled) {
          finalizationSeen = true;
          yield {
            type: "complete",
            turn: {
              text: "已完成。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        if (finished) {
          yield {
            type: "complete",
            turn: {
              text: "构建、部署和验证均已完成。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        if (buildSeen) {
          yield {
            type: "complete",
            turn: {
              text: "已完成实际修改和验证。",
              calls: [
                {
                  id: "finish-plan",
                  name: "update_plan",
                  input: {
                    plan: [
                      {
                        step: "构建产物",
                        status: "completed",
                        requires: ["execute"],
                      },
                      {
                        step: "修改并部署",
                        status: "completed",
                        requires: ["modify"],
                      },
                    ],
                  },
                },
                {
                  id: "real-modification",
                  name: "write_file",
                  input: { path: "target.txt", content: "after\n" },
                },
              ],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          finished = true;
          buildSeen = false;
          return;
        }
        if (rounds === 1) {
          yield {
            type: "complete",
            turn: {
              text: "先建立执行计划。",
              calls: [
                {
                  id: "initial-plan",
                  name: "update_plan",
                  input: {
                    plan: [
                      {
                        step: "构建产物",
                        status: "in_progress",
                        requires: ["execute"],
                      },
                      {
                        step: "修改并部署",
                        status: "pending",
                        requires: ["modify"],
                      },
                    ],
                  },
                },
                {
                  id: "initial-check",
                  name: "path_info",
                  input: { path: "check-0.txt" },
                },
              ],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        if (recoveryCount >= 3) {
          buildSeen = true;
          yield {
            type: "complete",
            turn: {
              text: "构建已成功，继续部署。",
              calls: [
                {
                  id: "successful-build",
                  name: "run_command",
                  input: {
                    command: "echo build-complete",
                    purpose: "execute",
                  },
                },
              ],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "继续检查。",
            calls: [
              {
                id: `read-${rounds}`,
                name: "path_info",
                input: { path: `check-${rounds - 1}.txt` },
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

  assert.equal(finalizationSeen, false);
  assert.equal(
    await readFile(path.join(workspacePath, "target.txt"), "utf8"),
    "after\n",
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.equal(done?.result?.kind, "changed");
  assert.ok(rounds <= 18, `expected bounded execution, received ${rounds}`);
});

test("bounds repeated successful validation commands", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-validation-stall-"),
  );
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "验证远程服务状态" }],
    permissionMode: "full-access",
    workspacePath,
  };
  let rounds = 0;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "repeated-validation-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        if (!args.toolsEnabled) {
          finalizationSeen = true;
          yield {
            type: "complete",
            turn: {
              text: "服务状态已确认，未发现新的变化。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "继续确认服务状态。",
            calls: [
              {
                id: `validation-${rounds}`,
                name: "run_command",
                input: {
                  command: "echo stable-check",
                  purpose: "validate",
                },
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

  assert.equal(finalizationSeen, true);
  assert.ok(
    rounds <= 7,
    `expected bounded validation loop, received ${rounds}`,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" &&
        (event.message.includes("重复") ||
          event.message.includes("没有产生实际状态变化")),
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.notEqual(done?.result?.kind, "incomplete");
});

test("finalizes a recovered completed plan without another tool loop", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-completed-plan-finalization-"),
  );
  const plan = [
    {
      step: "确认当前状态",
      status: "completed" as const,
      requires: ["inspect" as const],
    },
    {
      step: "执行目标操作",
      status: "completed" as const,
      requires: ["modify" as const],
    },
    {
      step: "验证最终结果",
      status: "completed" as const,
      requires: ["validate" as const],
    },
  ];
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "汇总已完成的任务" }],
    permissionMode: "full-access",
    workspacePath,
    recoveryPlan: { steps: plan, current: 2, requirementsDeclared: true },
    recoveryEvidence: {
      coding: ["inspect", "modify", "execute", "validate"],
      browser: [],
      git: [],
    },
  };
  let rounds = 0;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "completed-plan-finalization-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        finalizationSeen ||= !args.toolsEnabled;
        if (!args.toolsEnabled) {
          yield {
            type: "complete",
            turn: {
              text: "已根据实际工具记录完成汇总。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "整理已完成计划。",
            calls: [
              {
                id: "repeat-completed-plan",
                name: "update_plan",
                input: { plan },
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

  assert.equal(rounds, 2);
  assert.equal(finalizationSeen, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" &&
        event.message.includes("结构化计划和工具证据均已完成"),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "done" && event.outcome === "completed",
    ),
  );
});

test("bounds changing explanations on an unchanged recovery plan", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-plan-maintenance-stall-"),
  );
  const plan = [
    {
      step: "确认当前状态",
      status: "completed" as const,
      requires: ["inspect" as const],
    },
    {
      step: "执行目标操作",
      status: "completed" as const,
      requires: ["modify" as const],
    },
  ];
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "继续完成任务" }],
    permissionMode: "full-access",
    workspacePath,
    recoveryPlan: { steps: plan, current: 1, requirementsDeclared: true },
    recoveryEvidence: { coding: ["inspect"], browser: [], git: [] },
  };
  let rounds = 0;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "plan-maintenance-stall-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        finalizationSeen ||= !args.toolsEnabled;
        if (!args.toolsEnabled) {
          yield {
            type: "complete",
            turn: {
              text: "已保留现有结果，并明确列出尚未取得的修改证据。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "继续整理。",
            calls: [
              {
                id: `plan-maintenance-${rounds}`,
                name: "update_plan",
                input: {
                  explanation: `第 ${rounds} 次说明`,
                  plan,
                },
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

  assert.ok(
    rounds <= 9,
    `expected bounded plan-maintenance recovery, received ${rounds} rounds`,
  );
  assert.equal(finalizationSeen, true);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "paused");
  assert.equal(done?.result?.kind, "incomplete");
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("removes stale image payloads when compacting a long run", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-image-compaction-"),
  );
  const image = {
    id: "stale-image",
    name: "old-screenshot.png",
    mediaType: "image/png" as const,
    dataUrl: `data:image/png;base64,${"A".repeat(120_000)}`,
    size: 90_000,
  };
  const messages: ModelRequest["messages"] = [
    {
      role: "user",
      content: "请根据这些截图检查项目。",
      images: Array.from({ length: 8 }, (_, index) => ({
        ...image,
        id: `stale-image-${index}`,
      })),
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `历史记录 ${index + 1}`,
    })),
  ];
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages,
    permissionMode: "full-access",
    workspacePath,
    contextWindow: 100_000,
  };
  let observedHistory: Array<{
    kind: string;
    images?: unknown[];
    content?: string;
  }> = [];
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "image-compaction-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        observedHistory = args.history.map((item) => ({
          kind: item.kind,
          images: item.kind === "message" ? item.images : undefined,
          content: item.kind === "message" ? item.content : undefined,
        }));
        yield {
          type: "complete",
          turn: {
            text: "已根据现有记录完成检查。",
            calls: [],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  ))
    events.push(event);

  assert.ok(
    events.some(
      (event) =>
        event.type === "context_compaction" &&
        event.phase === "completed" &&
        event.changed,
    ),
  );
  assert.equal(
    observedHistory.some((item) => Boolean(item.images?.length)),
    false,
  );
  assert.ok(
    observedHistory.some((item) =>
      item.content?.includes("runtime_image_context_removed"),
    ),
  );
  assert.ok(events.some((event) => event.type === "done"));
});

test("context compaction does not reset the semantic stall guard", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-compaction-stall-"),
  );
  await writeFile(
    path.join(workspacePath, "probe.txt"),
    Array.from({ length: 24 }, (_, index) => `line-${index + 1}`).join("\n"),
    "utf8",
  );
  const image = {
    id: "loop-image",
    name: "loop.png",
    mediaType: "image/png" as const,
    dataUrl: `data:image/png;base64,${"A".repeat(120_000)}`,
    size: 90_000,
  };
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [
      {
        role: "user",
        content: "请持续检查 probe.txt 的内容。",
        images: Array.from({ length: 8 }, (_, index) => ({
          ...image,
          id: `loop-image-${index}`,
        })),
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        content: `此前检查记录 ${index + 1}`,
      })),
    ],
    permissionMode: "full-access",
    workspacePath,
    // The runtime overhead intentionally keeps compaction active every round.
    contextWindow: 50_000,
  };
  let rounds = 0;
  let compactions = 0;
  let finalizationSeen = false;
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    "compaction-stall-integration",
    request,
    new AbortController().signal,
    {
      getProvider: fakeProvider(),
      async *streamTurn(args) {
        rounds += 1;
        if (rounds > 16)
          throw new Error("semantic stall guard did not stop the loop");
        finalizationSeen ||= !args.toolsEnabled;
        if (!args.toolsEnabled) {
          yield {
            type: "complete",
            turn: {
              text: "已停止重复检查，并根据已有记录汇总。",
              calls: [],
              rawCalls: [],
              usage: { input: 10, output: 5, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text: "继续检查下一段。",
            calls: [
              {
                id: `compaction-read-${rounds}`,
                name: "read_file",
                input: {
                  path: "probe.txt",
                  startLine: rounds,
                  endLine: rounds,
                },
              },
            ],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
      },
    },
  )) {
    events.push(event);
    if (event.type === "context_compaction" && event.phase === "completed")
      compactions += 1;
  }

  assert.ok(compactions > 0);
  assert.ok(rounds <= 11, `expected bounded rounds, received ${rounds}`);
  assert.equal(finalizationSeen, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" &&
        event.message.includes("没有产生实际状态变化"),
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
});
