import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, ModelRequest } from "../src/types";
import { classifyRuntimeError } from "../src/runtime-errors";
import { runAgent, type RunAgentDeps } from "./agent";
import type { ToolCall, TurnStreamEvent } from "./agent-types";
import { FirstByteTimeoutError, isRetryableStreamError } from "./request-guard";
import { SseStreamTimeoutError } from "./sse-stream";

const generationError = () =>
  new Error("Internal error during token generation");
const getProvider: RunAgentDeps["getProvider"] = async () =>
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
        displayName: "Fake",
        protocol: "openai-chat",
      },
    ],
    apiKey: "fixture",
    apiKeys: ["fixture"],
  }) as never;

function toolTurn(calls: ToolCall[]): TurnStreamEvent {
  return {
    type: "complete",
    turn: {
      text: "",
      calls,
      rawCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
    },
  };
}

function successfulActivities(events: AgentEvent[], tool: ToolCall["name"]) {
  return new Set(
    events.flatMap((event) =>
      event.type === "activity" &&
      event.activity.tool === tool &&
      event.activity.status === "success"
        ? [event.activity.id]
        : [],
    ),
  );
}

async function fixture(cleanup = false) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-finalization-recovery-"),
  );
  await writeFile(path.join(workspacePath, "result.js"), "const value = 1;\n");
  if (cleanup)
    await writeFile(path.join(workspacePath, "temporary.txt"), "temporary");
  const request: ModelRequest = {
    providerId: "fake",
    modelId: "fake-model",
    permissionMode: "full-access",
    workspacePath,
    messages: [{ role: "user", content: "修改 result.js 并验证最终结果" }],
  };
  const calls: ToolCall[] = [
    { id: "read", name: "read_file", input: { path: "result.js" } },
    {
      id: "write",
      name: "write_file",
      input: { path: "result.js", content: "const value = 2;\n" },
    },
    {
      id: "validate",
      name: "run_command",
      input: { command: "node --check result.js", purpose: "validate" },
    },
    ...(cleanup
      ? [
          {
            id: "cleanup",
            name: "delete_path" as const,
            input: { path: "temporary.txt" },
          },
        ]
      : []),
    {
      id: "plan",
      name: "update_plan",
      input: {
        plan: [
          { step: "读取文件", status: "completed", requires: ["inspect"] },
          { step: "完成修改与清理", status: "completed", requires: ["modify"] },
          { step: "核验结果", status: "completed", requires: ["validate"] },
        ],
      },
    },
  ];
  return { request, calls };
}

test("requests only revalidation after cleanup, then safely finalizes a failed summary", async () => {
  const { request, calls } = await fixture(true);
  const events: AgentEvent[] = [];
  let rounds = 0;
  for await (const event of runAgent(
    "cleanup-finalization",
    request,
    new AbortController().signal,
    {
      getProvider,
      async *streamTurn(args) {
        rounds++;
        if (rounds === 1) {
          yield toolTurn(calls);
          return;
        }
        if (rounds === 2) {
          assert.equal(
            args.toolsEnabled,
            true,
            "cleanup invalidates earlier validation",
          );
          assert.ok(
            args.history.some(
              (item) =>
                item.kind === "message" &&
                item.content.includes("补一次只读核验"),
            ),
          );
          yield toolTurn([
            {
              id: "revalidate",
              name: "run_command",
              input: { command: "node --check result.js", purpose: "validate" },
            },
          ]);
          return;
        }
        assert.equal(rounds, 3);
        assert.equal(args.toolsEnabled, false);
        throw generationError();
      },
    },
  ))
    events.push(event);
  assert.equal(rounds, 3);
  assert.equal(
    events.find((event) => event.type === "done")?.outcome,
    "completed",
  );
  assert.equal(successfulActivities(events, "write_file").size, 1);
  assert.equal(successfulActivities(events, "run_command").size, 2);
});

for (const cancelled of [false, true]) {
  test(`does not hide ${cancelled ? "cancellation" : "authentication failure"} behind a completed summary`, async () => {
    const { request, calls } = await fixture();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const error = cancelled ? generationError() : new Error("invalid api key");
    let rounds = 0;
    await assert.rejects(async () => {
      for await (const event of runAgent(
        `finalization-stop-${cancelled}`,
        request,
        controller.signal,
        {
          getProvider,
          async *streamTurn(args) {
            rounds++;
            if (rounds === 1) {
              yield toolTurn(calls);
              return;
            }
            assert.equal(args.toolsEnabled, false);
            if (cancelled) controller.abort();
            throw error;
          },
        },
      ))
        events.push(event);
    }, error);
    assert.equal(rounds, 2);
    assert.ok(!events.some((event) => event.type === "done"));
  });
}

test("classifies provider token generation failures as transient in both runtime layers", () => {
  assert.equal(isRetryableStreamError(generationError()), true);
  assert.deepEqual(classifyRuntimeError(generationError().message), {
    kind: "provider_unavailable",
    retryable: true,
    userAction: "retry",
  });
  for (const message of [
    "invalid api key",
    "invalid token",
    "maximum context length exceeded",
    "Internal error in local tool",
  ]) {
    assert.equal(isRetryableStreamError(new Error(message)), false);
    assert.equal(classifyRuntimeError(message).retryable, false);
  }
});

for (const [label, failure] of [
  ["token generation error", generationError],
  ["connection drop", () => new Error("net::ERR_CONNECTION_CLOSED")],
  ["first-byte timeout", () => new FirstByteTimeoutError(120_000)],
  ["absolute timeout", () => new SseStreamTimeoutError("absolute", 120_000)],
] as const) {
  test(`finalizes a newly completed plan from tool records after ${label}`, async () => {
    const { request, calls } = await fixture();
    const events: AgentEvent[] = [];
    let rounds = 0;
    for await (const event of runAgent(
      `finalization-${label}`,
      request,
      new AbortController().signal,
      {
        getProvider,
        async *streamTurn(args) {
          rounds++;
          if (rounds === 1) {
            yield toolTurn(calls);
            return;
          }
          assert.equal(rounds, 2, "must not reopen tool execution");
          assert.equal(
            args.toolsEnabled,
            false,
            "a just-completed plan must enter bounded finalization",
          );
          yield { type: "text", delta: "unfinished model fragment" };
          throw failure();
        },
      },
    ))
      events.push(event);
    assert.equal(rounds, 2);
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.outcome, "completed");
    assert.deepEqual(done?.result?.missingOperations, []);
    assert.ok(
      events.some(
        (event) =>
          event.type === "text" && event.delta.includes("只依据实际工具记录"),
      ),
    );
    assert.ok(
      !events.some(
        (event) =>
          event.type === "text" &&
          event.delta.includes("unfinished model fragment"),
      ),
    );
    assert.equal(successfulActivities(events, "write_file").size, 1);
    assert.equal(
      await readFile(path.join(request.workspacePath!, "result.js"), "utf8"),
      "const value = 2;\n",
    );
  });
}
