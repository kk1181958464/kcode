import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, ModelRequest } from "../src/types";
import {
  resolveAgentModelTurn,
  type AgentModelTurnContext,
} from "./agent-model-turn";
import {
  executeAgentToolTurn,
  type AgentToolTurnContext,
} from "./agent-tool-turn";
import { buildRoundEvidenceSnapshot } from "./agent-round-policy";
import { createRunState } from "./agent-run-state";
import type { ModelStreamFn, Turn } from "./agent-types";
import { FileReadCache } from "./file-read-cache";
import { ToolStatsTracker } from "./tool-stats";
import { TurnDiffTracker } from "./turn-diff-tracker";
import { successfulCodingEvidence } from "./coding-operation-verification";
import { execute } from "./agent-tool-runtime";
import { invalidateHookConfig } from "./hook-lifecycle";

async function drain<T>(generator: AsyncGenerator<AgentEvent, T>) {
  const events: AgentEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    // Match the event snapshots delivered over IPC, not later object mutations.
    events.push(structuredClone(next.value));
  }
}

function request(workspacePath = process.cwd()): ModelRequest {
  return {
    workspacePath,
    providerId: "fixture",
    modelId: "fixture",
    permissionMode: "full-access",
    messages: [{ role: "user", content: "查看当前状态" }],
  };
}

function modelContext(streamTurn: ModelStreamFn): AgentModelTurnContext {
  const run = createRunState();
  return {
    root: process.cwd(),
    requestId: "model-phase-fixture",
    request: request(),
    signal: new AbortController().signal,
    run,
    history: [],
    evidenceHistory: [],
    baselineCodingEvidence: new Set(),
    browserSessionId: "model-phase-fixture",
    modelRuntime: {
      activeSkills: "",
      provider: {
        id: "fixture",
        name: "Fixture",
        protocol: "openai-chat",
        enabled: true,
        baseUrl: "https://example.invalid",
        apiKey: "fixture",
        apiKeys: ["fixture"],
        models: [],
      },
    },
    usage: { input: 0, output: 0, cached: 0 },
    streamTurn,
    finalizationMode: undefined,
    roundStartSnapshot: buildRoundEvidenceSnapshot({
      plannerCoordinator: false,
      plan: run.plan,
      requestedCodingEvidenceOps: run.requestedCodingEvidenceOps,
      requestedBrowserOps: run.requestedBrowserOps,
      requestedGitOps: run.requestedGitOps,
      codingEvidence: new Set(),
      browserEvidence: new Set(),
      gitEvidence: new Set(),
      unavailableGit: new Set(),
      successfulTools: new Set(),
      evidenceHistory: [],
      hasUncollectedAgentWork: false,
    }),
    requestContainsImages: false,
    toolsEnabled: true,
    hasUncollectedAgentWork: false,
    hasActiveUncollectedAgentWork: false,
    collectStoppedSubagents: async () => ({
      activities: [],
      usageDelta: { input: 0, output: 0, cached: 0 },
    }),
  };
}

const emptyTurn: Turn = {
  text: "",
  calls: [],
  rawCalls: [],
  usage: { input: 0, output: 0, cached: 0 },
};

function toolContext(root: string): AgentToolTurnContext {
  return {
    root,
    requestId: path.basename(root),
    request: request(root),
    signal: new AbortController().signal,
    run: createRunState(),
    history: [],
    evidenceHistory: [],
    baselineCodingEvidence: new Set(),
    recoveredBrowserEvidence: new Set(),
    recoveredGitEvidence: new Set(),
    browserSessionId: path.basename(root),
    plannerCoordinator: false,
    fileReadCache: new FileReadCache(),
    turnDiffTracker: new TurnDiffTracker(root),
    toolStats: new ToolStatsTracker(),
    conversationWriter: { toolCall() {}, toolResult() {} },
    activeConnectionFacts: new Map(),
    usage: { input: 0, output: 0, cached: 0 },
    refreshRuntimeWorkspaceBinding: async () => {},
    async *runChildAgent() {
      throw new Error("unexpected child agent execution");
    },
  };
}

test("tool phase preserves permission denial while recording later successful reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-tool-phase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "sample.txt"), "original");
  const context = toolContext(root);
  context.request.permissionMode = "read-only";
  const persistedCalls: string[] = [];
  context.conversationWriter.toolCall = (id) => {
    persistedCalls.push(id);
  };
  const { events, result } = await drain(
    executeAgentToolTurn(
      context,
      {
        ...emptyTurn,
        calls: [
          {
            id: "write",
            name: "write_file",
            input: { path: "sample.txt", content: "replacement" },
          },
          { id: "read", name: "read_file", input: { path: "sample.txt" } },
        ],
      },
      "读取当前内容",
    ),
  );
  assert.equal(
    await readFile(path.join(root, "sample.txt"), "utf8"),
    "original",
  );
  assert.equal(result.roundFailedActivity?.status, "denied");
  assert.equal(result.roundFailedActivity?.tool, "write_file");
  assert.equal(result.roundAdvanced, false);
  assert.deepEqual(persistedCalls, ["write", "read"]);
  const evidence = successfulCodingEvidence(context.evidenceHistory);
  assert.equal(evidence.has("inspect"), true);
  assert.equal(evidence.has("modify"), false);
  const activities = events.filter((event) => event.type === "activity");
  assert.equal(activities[0]?.activity.status, "denied");
  assert.equal(activities[1]?.activity.status, "running");
  assert.equal(activities.at(-1)?.activity.status, "success");
  assert.ok(
    !events.some((event) => event.type === "done" || event.type === "error"),
  );
});

test("tool phase returns requested user input for the runner to finalize", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-tool-input-phase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = toolContext(root);
  const { events, result } = await drain(
    executeAgentToolTurn(
      context,
      {
        ...emptyTurn,
        calls: [
          {
            id: "question",
            name: "request_user_input",
            input: { question: "要修改哪个文件？", fields: ["path"] },
          },
        ],
      },
      "确认目标文件",
    ),
  );
  assert.equal(result.pendingUserInput?.question, "要修改哪个文件？");
  assert.deepEqual(result.pendingUserInput?.fields, ["path"]);
  assert.equal(result.roundFailedActivity, undefined);
  assert.ok(
    !events.some((event) => event.type === "done" || event.type === "error"),
  );
});

test("model phase preserves streamed reset offsets and returns control before completion", async () => {
  const context = modelContext(async function* () {
    yield { type: "text", delta: "draft" };
    yield { type: "text_reset", replacement: "final" };
    yield {
      type: "complete",
      turn: {
        ...emptyTurn,
        text: "final",
        usage: { input: 12, output: 5, cached: 3 },
      },
    };
  });
  context.run.timelineTextLength = 40;
  const { events, result } = await drain(resolveAgentModelTurn(context));
  assert.equal(result.action, "ready");
  if (result.action !== "ready") return;
  assert.equal(result.streamedText, "final");
  assert.equal(result.turnTextStartOffset, 40);
  assert.equal(context.run.timelineTextLength, 45);
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "text_reset", "usage"],
  );
  assert.deepEqual(events[1], {
    type: "text_reset",
    textOffset: 40,
    replacement: "final",
    reason: "stream_retry",
  });
  assert.deepEqual(context.usage, { input: 12, output: 5, cached: 3 });
});

test("an empty model round requests continuation without ending the agent", async () => {
  const context = modelContext(async function* () {
    yield { type: "complete", turn: emptyTurn };
  });
  const { events, result } = await drain(resolveAgentModelTurn(context));
  assert.equal(result.action, "continue");
  assert.equal(context.run.budgets.emptyTurns, 1);
  assert.ok(
    context.history.length > 0,
    "recovery instruction must reach the next round",
  );
  assert.ok(
    !events.some((event) => event.type === "done" || event.type === "error"),
  );
});

test("closing the model phase closes its active stream", async () => {
  let closed = false;
  const context = modelContext(async function* () {
    try {
      yield { type: "text", delta: "partial" };
      throw new Error("closed streams must not resume generation");
    } finally {
      closed = true;
    }
  });
  const phase = resolveAgentModelTurn(context);
  const first = await phase.next();
  assert.ok(!first.done);
  assert.equal(first.value.type, "text");
  await phase.return({ action: "stop" });
  assert.equal(closed, true);
});

for (const hasEvidence of [false, true]) {
  test(`transport failure returns ${hasEvidence ? "continue" : "stop"} with matching terminal events`, async () => {
    const context = modelContext(async function* () {
      throw new Error("Internal error during token generation");
    });
    if (hasEvidence)
      context.evidenceHistory.push(
        {
          kind: "calls",
          calls: [
            { id: "read", name: "read_file", input: { path: "sample.txt" } },
          ],
          rawCalls: [],
        },
        {
          kind: "result",
          callId: "read",
          content: JSON.stringify({ success: true, summary: "read", data: {} }),
        },
      );
    const { events, result } = await drain(resolveAgentModelTurn(context));
    assert.equal(result.action, hasEvidence ? "continue" : "stop");
    assert.equal(
      context.run.budgets.streamTimeoutRecoveries,
      hasEvidence ? 1 : 0,
    );
    const terminal = events.filter(
      (event) => event.type === "done" || event.type === "error",
    );
    assert.equal(terminal.length, hasEvidence ? 0 : 1);
    if (!hasEvidence)
      assert.equal(
        events.find((event) => event.type === "done")?.outcome,
        "paused",
      );
  });
}

test("exhausted premature stream ends pause without marking the task complete", async () => {
  const context = modelContext(async function* () {
    yield { type: "text", delta: "Creating the HTML." };
    throw new Error("Upstream stream ended before completion");
  });
  const { events, result } = await drain(resolveAgentModelTurn(context));
  assert.equal(result.action, "stop");
  assert.ok(events.some((event) => event.type === "text" && event.delta === "Creating the HTML."));
  assert.ok(!events.some((event) => event.type === "error"));
  const terminal = events.filter((event) => event.type === "done");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].outcome, "paused");
  assert.equal(terminal[0].result?.kind, "incomplete");
});

for (const blocking of [false, true]) {
  test(`cancelling during a ${blocking ? "blocking" : "non-blocking"} pre-tool hook prevents patch writes`, { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kcode-hook-cancel-"));
    t.after(() => rm(root, {
      recursive: true, force: true, maxRetries: 20, retryDelay: 100,
    }));
    await writeFile(path.join(root, "sample.txt"), "original\n");
    await mkdir(path.join(root, ".kcode"));
    await writeFile(path.join(root, ".kcode", "hooks.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          type: "command",
          matcher: "apply_patch",
          blocking,
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('hook-started', ''); setTimeout(() => {}, 1000)"`,
        }],
      },
    }));
    invalidateHookConfig();
    const context = toolContext(root);
    const controller = new AbortController();
    context.signal = controller.signal;
    const pending = drain(executeAgentToolTurn(context, {
      ...emptyTurn,
      calls: [{
        id: "patch",
        name: "apply_patch",
        input: {
          patch: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-original\n+replacement\n*** End Patch",
        },
      }],
    }, ""));
    try {
      const started = path.join(root, "hook-started");
      const deadline = Date.now() + 5_000;
      while (!existsSync(started) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(started), "hook must be running before cancellation");
      controller.abort();
      const { events, result } = await pending;
      assert.equal(await readFile(path.join(root, "sample.txt"), "utf8"), "original\n");
      assert.equal(result.roundAdvanced, false);
      assert.equal(successfulCodingEvidence(context.evidenceHistory).has("modify"), false);
      const last = events.filter((event) => event.type === "activity").at(-1);
      assert.equal(last?.activity.status, "failed");
      assert.equal(last?.activity.errorSummary, "操作已停止");
    } finally {
      controller.abort();
      await pending;
    }
  });
}

test("the tool dispatcher rejects an already cancelled patch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-patch-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "sample.txt"), "original\n");
  const context = toolContext(root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute(
    root, context.requestId, context.browserSessionId, "cancelled-patch",
    {
      id: "patch",
      name: "apply_patch",
      input: {
        patch: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-original\n+replacement\n*** End Patch",
      },
    },
    context.request, controller.signal, context.fileReadCache, context.runChildAgent,
  ), /任务已取消/);
  assert.equal(await readFile(path.join(root, "sample.txt"), "utf8"), "original\n");
});
