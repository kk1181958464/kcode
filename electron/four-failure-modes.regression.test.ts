import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, type RunAgentDeps } from "./agent";
import type { AgentEvent, ModelRequest } from "../src/types";
import {
  REASONING_ONLY_RETRY_LIMIT,
  shouldForceToolAfterEmptyRecovery,
} from "./agent-round-policy";
import {
  agentFinalizationMode,
  EXECUTOR_HARD_DURATION_MS,
  EXECUTOR_HARD_ROUND_LIMIT,
  ROOT_HARD_DURATION_MS,
  ROOT_HARD_ROUND_LIMIT,
} from "./agent-run-budget";
import { clearFailedBaselineCodingEvidence } from "./coding-operation-verification";
import {
  CONSECUTIVE_UNPRODUCTIVE_TURN_LIMIT,
  REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT,
  requiredEvidenceHook,
} from "./stop-hooks";

function fakeProvider(modelId: string): RunAgentDeps["getProvider"] {
  return async () =>
    ({
      id: "fake",
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://example.invalid",
      enabled: true,
      models: [
        { id: modelId, modelId, displayName: modelId, protocol: "openai-chat" },
      ],
      apiKey: "sk-fake",
      apiKeys: ["sk-fake"],
    }) as any;
}

async function makeRequest(
  content = "请修改 hello.txt",
): Promise<ModelRequest> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-four-mode-"),
  );
  return {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content }],
    permissionMode: "full-access",
    workspacePath,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("regression: empty thinking arms requireToolCall after a soft retry", async () => {
  assert.equal(
    shouldForceToolAfterEmptyRecovery({
      toolsEnabled: true,
      hasRecoverableToolEvidence: false,
      actionablePlanPending: false,
      hasRequestedCodingOps: false,
      hasUncollectedAgentWork: false,
      priorEmptyOrReasoningRetries: 0,
    }),
    true,
  );
  assert.equal(
    shouldForceToolAfterEmptyRecovery({
      toolsEnabled: true,
      hasRecoverableToolEvidence: false,
      actionablePlanPending: false,
      hasRequestedCodingOps: false,
      hasUncollectedAgentWork: false,
      priorEmptyOrReasoningRetries: 1,
    }),
    true,
  );

  const request = await makeRequest("继续处理任务");
  const requireToolCallSeen: boolean[] = [];
  let rounds = 0;
  const events = await collect(
    runAgent(
      "regression-empty-thinking-force-tool",
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider("fake-model"),
        async *streamTurn(args) {
          rounds += 1;
          requireToolCallSeen.push(Boolean(args.requireToolCall));
          yield { type: "reasoning", delta: "仍在内部思考" };
          yield {
            type: "complete",
            turn: {
              text: "",
              reasoningContent: "仍在内部思考",
              calls: [],
              rawCalls: [],
              usage: { input: 4, output: 2, cached: 0 },
            },
          };
        },
      },
    ),
  );

  assert.equal(rounds, REASONING_ONLY_RETRY_LIMIT + 1);
  assert.ok(requireToolCallSeen.length >= 2);
  assert.equal(requireToolCallSeen[0], false);
  assert.ok(
    requireToolCallSeen.slice(1).every(Boolean),
    `later turns must force tools, got ${requireToolCallSeen.join(",")}`,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "error" &&
        String(event.message).includes("连续只返回内部思考"),
    ),
  );
});

test("regression: recoverable tool evidence forces tools on the first empty recovery", async () => {
  assert.equal(
    shouldForceToolAfterEmptyRecovery({
      toolsEnabled: true,
      hasRecoverableToolEvidence: true,
      actionablePlanPending: false,
      hasRequestedCodingOps: false,
      hasUncollectedAgentWork: false,
      priorEmptyOrReasoningRetries: 0,
    }),
    true,
  );

  const request = await makeRequest("创建 hello.txt");
  const requireToolCallSeen: boolean[] = [];
  let round = 0;
  await collect(
    runAgent(
      "regression-empty-after-tool-forces",
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider("fake-model"),
        async *streamTurn(args) {
          round += 1;
          requireToolCallSeen.push(Boolean(args.requireToolCall));
          if (round === 1) {
            yield {
              type: "complete",
              turn: {
                text: "",
                calls: [
                  {
                    id: "write-1",
                    name: "write_file",
                    input: { path: "hello.txt", content: "hi\n" },
                  },
                ],
                rawCalls: [],
                usage: { input: 5, output: 2, cached: 0 },
              },
            };
            return;
          }
          yield {
            type: "complete",
            turn: {
              text: "",
              calls: [],
              rawCalls: [],
              usage: { input: 2, output: 0, cached: 0 },
            },
          };
        },
      },
    ),
  );

  assert.ok(round >= 2);
  assert.ok(
    requireToolCallSeen.slice(1).some(Boolean),
    `empty recovery after tools must arm requireToolCall, got ${requireToolCallSeen.join(",")}`,
  );
});

test("regression: pending instructions never disable the hard run limit", () => {
  assert.equal(
    agentFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: EXECUTOR_HARD_DURATION_MS,
      evidenceComplete: true,
      hasPendingInstructions: true,
    }),
    "limit-reached",
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: undefined,
      completedRounds: ROOT_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
      hasPendingInstructions: true,
    }),
    "limit-reached",
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: undefined,
      completedRounds: 1,
      elapsedMs: ROOT_HARD_DURATION_MS,
      evidenceComplete: false,
      hasPendingInstructions: true,
    }),
    "limit-reached",
  );
});

test("regression: Codex-style fuse aligns evidence hard ceiling with consecutive unproductive limit", () => {
  assert.equal(REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT, CONSECUTIVE_UNPRODUCTIVE_TURN_LIMIT);
  assert.equal(CONSECUTIVE_UNPRODUCTIVE_TURN_LIMIT, 3);
});

test("regression: missing evidence keeps forcing tools until the hard ceiling", async () => {
  for (let retryCount = 0; retryCount < REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT; retryCount++) {
    const result = requiredEvidenceHook.evaluate({
      requestedOperations: ["coding:modify"],
      observedOperations: [],
      missingOperations: ["coding:modify"],
      waitingForUser: false,
      retryCount,
    });
    assert.equal(result.action, "continue");
    if (result.action === "continue") {
      assert.equal(result.forceToolCall, true);
      assert.match(result.inject, /完成审计/);
    }
  }
  assert.deepEqual(
    requiredEvidenceHook.evaluate({
      requestedOperations: ["coding:modify"],
      observedOperations: [],
      missingOperations: ["coding:modify"],
      waitingForUser: false,
      retryCount: REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT,
    }),
    { action: "allow" },
  );

  const request = await makeRequest("处理这个任务");
  const requireToolCallSeen: boolean[] = [];
  let streamCalls = 0;
  const events = await collect(
    runAgent(
      "regression-early-stop-force-evidence",
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider("fake-model"),
        async *streamTurn(args) {
          streamCalls += 1;
          requireToolCallSeen.push(Boolean(args.requireToolCall));
          if (streamCalls === 1) {
            yield {
              type: "complete",
              turn: {
                text: "开始处理。",
                calls: [
                  {
                    id: "bad-patch",
                    name: "apply_patch",
                    input: { patch: "not a patch" },
                  },
                ],
                rawCalls: [],
                usage: { input: 5, output: 3, cached: 0 },
              },
            };
            return;
          }
          yield { type: "text", delta: "无法完成修改。" };
          yield {
            type: "complete",
            turn: {
              text: "无法完成修改。",
              calls: [],
              rawCalls: [],
              usage: { input: 5, output: 3, cached: 0 },
            },
          };
        },
      },
    ),
  );

  assert.equal(streamCalls, 1 + REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT + 1);
  assert.ok(
    requireToolCallSeen.slice(1).every(Boolean),
    `evidence continues must force tools, got ${requireToolCallSeen.join(",")}`,
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "incomplete");
  assert.ok(done?.result?.missingOperations.includes("coding:modify"));
});

test("regression: recovered baseline survives never-executed re-attempts", () => {
  const baseline = new Set(["modify", "execute"]);
  clearFailedBaselineCodingEvidence(baseline as any, [], new Set());
  assert.deepEqual([...baseline].sort(), ["execute", "modify"]);
  clearFailedBaselineCodingEvidence(baseline as any, ["modify"] as any, new Set(["execute"] as any));
  assert.deepEqual([...baseline].sort(), ["execute"]);
  baseline.add("modify");
  clearFailedBaselineCodingEvidence(baseline as any, ["modify"] as any, new Set(["modify"] as any));
  assert.ok(baseline.has("modify"));
});

test("regression: recovered modify evidence lets a text-only wrap-up finish as done", async () => {
  const request = await makeRequest("汇总已完成的修改");
  request.recoveryEvidence = { coding: ["modify"], browser: [], git: [] };
  let rounds = 0;
  const events = await collect(
    runAgent(
      "regression-false-incomplete-baseline-kept",
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider("fake-model"),
        async *streamTurn() {
          rounds += 1;
          yield { type: "text", delta: "修改已经完成。" };
          yield {
            type: "complete",
            turn: {
              text: "修改已经完成。",
              calls: [],
              rawCalls: [],
              usage: { input: 6, output: 4, cached: 0 },
            },
          };
        },
      },
    ),
  );

  assert.equal(rounds, 1);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.ok(done);
  assert.notEqual(done?.result?.kind, "incomplete");
  assert.equal(
    done?.result?.missingOperations?.includes("coding:modify") ?? false,
    false,
  );
});

test("regression: a failed re-attempt can clear unproven recovered modify evidence", async () => {
  const request = await makeRequest("再改一次 hello.txt");
  request.recoveryEvidence = { coding: ["modify"], browser: [], git: [] };
  let rounds = 0;
  const events = await collect(
    runAgent(
      "regression-false-incomplete-failed-clears",
      request,
      new AbortController().signal,
      {
        getProvider: fakeProvider("fake-model"),
        async *streamTurn() {
          rounds += 1;
          if (rounds === 1) {
            yield {
              type: "complete",
              turn: {
                text: "重试修改。",
                calls: [
                  {
                    id: "bad-patch-2",
                    name: "apply_patch",
                    input: { patch: "not a patch" },
                  },
                ],
                rawCalls: [],
                usage: { input: 5, output: 2, cached: 0 },
              },
            };
            return;
          }
          yield { type: "text", delta: "还是改不了。" };
          yield {
            type: "complete",
            turn: {
              text: "还是改不了。",
              calls: [],
              rawCalls: [],
              usage: { input: 5, output: 2, cached: 0 },
            },
          };
        },
      },
    ),
  );

  assert.ok(rounds >= 2);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "incomplete");
  assert.ok(done?.result?.missingOperations.includes("coding:modify"));
});
