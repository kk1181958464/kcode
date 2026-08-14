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
      (event) =>
        event.type === "text" && event.delta.includes("连续 5 轮"),
    ),
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.ok(
    events.some(
      (event) => event.type === "done" && event.outcome === "paused",
    ),
  );
});

test("finalizes after repeated closing checks even when each read-only command differs", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "kcode-closing-"));
  await writeFile(path.join(workspacePath, "first.txt"), "first\n", "utf8");
  await writeFile(path.join(workspacePath, "second.txt"), "second\n", "utf8");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "检查这两个文件并给出结论" }],
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
            item.content.includes("连续多轮声称正在进行最后或最终确认"),
        );
        if (rounds === 3) {
          finalizationDisabledTools = !args.toolsEnabled;
          yield {
            type: "complete",
            turn: {
              text: "结论：两个文件均存在，检查已经结束。",
              calls: [],
              rawCalls: [],
              usage: { input: 20, output: 8, cached: 0 },
            },
          };
          return;
        }
        yield {
          type: "complete",
          turn: {
            text:
              rounds === 1
                ? "我再做最后一次文件核对，然后直接给出结论。"
                : "最终复核另一个文件，结论以这次检查为准。",
            calls: [
              {
                id: `closing-call-${rounds}`,
                name: "path_info",
                input: { path: rounds === 1 ? "first.txt" : "second.txt" },
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

  assert.equal(rounds, 3);
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
  assert.equal(events.some((event) => event.type === "error"), false);
});
