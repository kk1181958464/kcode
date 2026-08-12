import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, resolveApproval, type RunAgentDeps } from "./agent";
import type { AgentEvent, ModelRequest } from "../src/types";

/**
 * First integration test for runAgent, made possible by the ModelStreamFn
 * injection seam: a scripted fake drives the loop with no provider/network,
 * so we can assert the event contract the UI depends on.
 */

/** A minimal enabled provider whose model list matches request.modelId. */
function fakeProvider(modelId: string): RunAgentDeps["getProvider"] {
  return async () =>
    ({
      id: "fake",
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://example.invalid",
      enabled: true,
      models: [{ id: modelId, modelId, displayName: modelId, protocol: "openai-chat" }],
      apiKey: "sk-fake",
      apiKeys: ["sk-fake"],
    }) as any;
}

async function makeRequest(): Promise<ModelRequest> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "kcode-runagent-"));
  return {
    providerId: "fake",
    modelId: "fake-model",
    messages: [{ role: "user", content: "解释一下这个项目是做什么的" }],
    permissionMode: "full-access",
    workspacePath,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("runAgent emits text then a completed done for a plain-text turn", async () => {
  const request = await makeRequest();
  // Scripted model turn: stream a sentence, then complete with no tool calls.
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      yield { type: "text", delta: "这个项目是一个多模型编码 Agent。" };
      yield {
        type: "complete",
        turn: {
          text: "这个项目是一个多模型编码 Agent。",
          calls: [],
          rawCalls: [],
          usage: { input: 10, output: 8, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent("test-req-1", request, new AbortController().signal, deps),
  );
  const types = events.map((e) => e.type);

  // The loop must produce visible answer text, mark the final response, and
  // finish with a completed done event.
  assert.ok(types.includes("text"), `expected a text event, got ${types.join(",")}`);
  assert.ok(types.includes("final_response"), "expected a final_response event");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "expected a done event");
  assert.equal((done as any).outcome, "completed");

  const answer = events
    .filter((e) => e.type === "text")
    .map((e) => (e as any).delta)
    .join("");
  assert.match(answer, /编码 Agent/);
});

test("runAgent pauses on confirm mode and resumes on resolveApproval", async () => {
  const request = await makeRequest();
  request.permissionMode = "confirm";
  request.messages = [{ role: "user", content: "创建 hello.txt" }];
  let round = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      round += 1;
      if (round === 1) {
        yield {
          type: "complete",
          turn: {
            text: "",
            calls: [
              { id: "call_1", name: "write_file", input: { path: "hello.txt", content: "hi\n" } },
            ],
            rawCalls: [],
            usage: { input: 12, output: 4, cached: 0 },
          },
        };
      } else {
        yield { type: "text", delta: "已创建。" };
        yield {
          type: "complete",
          turn: { text: "已创建。", calls: [], rawCalls: [], usage: { input: 20, output: 6, cached: 0 } },
        };
      }
    },
  };

  const reqId = "test-req-confirm";
  const events: AgentEvent[] = [];
  let approved = false;
  for await (const event of runAgent(reqId, request, new AbortController().signal, deps)) {
    events.push(event);
    // The write_file tool must pause for approval. The approval key is only
    // registered once the generator resumes PAST this yield, so defer the
    // resolve to a later tick (setImmediate) — resolving synchronously here
    // would miss the not-yet-registered key and deadlock.
    if (event.type === "activity" && event.activity.status === "waiting") {
      approved = true;
      const id = event.activity.id;
      setImmediate(() => resolveApproval(reqId, id, true));
    }
  }

  assert.ok(approved, "expected a waiting activity to approve");
  const written = await readFile(path.join(request.workspacePath, "hello.txt"), "utf8");
  assert.equal(written, "hi\n");
});

test("runAgent runs a tool call through the real tool loop", async () => {
  const request = await makeRequest();
  request.messages = [
    { role: "user", content: "创建一个 hello.txt，内容为 hi" },
  ];
  // Round 1: the model asks to write a file. Round 2 (after the tool result
  // comes back): it reports completion with no further calls.
  let round = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      round += 1;
      if (round === 1) {
        yield {
          type: "complete",
          turn: {
            text: "",
            calls: [
              {
                id: "call_1",
                name: "write_file",
                input: { path: "hello.txt", content: "hi\n" },
              },
            ],
            rawCalls: [],
            usage: { input: 12, output: 4, cached: 0 },
          },
        };
      } else {
        yield { type: "text", delta: "已创建 hello.txt。" };
        yield {
          type: "complete",
          turn: {
            text: "已创建 hello.txt。",
            calls: [],
            rawCalls: [],
            usage: { input: 20, output: 6, cached: 0 },
          },
        };
      }
    },
  };

  const events = await collect(
    runAgent("test-req-tool", request, new AbortController().signal, deps),
  );

  // The tool loop drives the real `write_file` tool: expect an activity event
  // for it, a successful outcome, and the file actually written to disk.
  const activities = events.filter((e) => e.type === "activity");
  assert.ok(activities.length > 0, "expected at least one activity event");
  const writeActivity = activities.find(
    (e) => (e as any).activity?.tool === "write_file",
  );
  assert.ok(writeActivity, "expected a write_file activity");

  const done = events.find((e) => e.type === "done");
  assert.ok(done, "expected a done event");

  const written = await readFile(path.join(request.workspacePath, "hello.txt"), "utf8");
  assert.equal(written, "hi\n");
});

test("runAgent retries when the model claims a change without tool evidence", async () => {
  const request = await makeRequest();
  request.messages = [
    { role: "user", content: "把 README.md 里的标题改成 Hello" },
  ];
  // The model keeps claiming success in prose but never calls a tool. The
  // verification loop must not accept that: it should re-prompt (call the model
  // again) at least once before finally settling.
  let streamCalls = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      streamCalls += 1;
      yield { type: "text", delta: "已完成修改。" };
      yield {
        type: "complete",
        turn: {
          text: "已完成修改。",
          calls: [],
          rawCalls: [],
          usage: { input: 5, output: 3, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent("test-req-verify", request, new AbortController().signal, deps),
  );
  // Characterize the current contract: an unproven modify claim forces at least
  // one re-prompt, and the run still terminates with a done event.
  assert.ok(
    streamCalls >= 2,
    `expected a verification re-prompt, model was called ${streamCalls}x`,
  );
  assert.ok(events.some((e) => e.type === "done"), "expected a done event");
});

test("runAgent stops promptly when the signal is already aborted", async () => {
  const request = await makeRequest();
  const controller = new AbortController();
  controller.abort(); // user hit stop before the first turn
  let streamCalls = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      streamCalls += 1;
      yield {
        type: "complete",
        turn: { text: "不该发生", calls: [], rawCalls: [], usage: { input: 0, output: 0, cached: 0 } },
      };
    },
  };

  // The `while (!signal.aborted)` guard must skip the turn entirely and the
  // generator must finish instead of hanging.
  const events = await collect(
    runAgent("test-req-abort", request, controller.signal, deps),
  );
  assert.equal(streamCalls, 0, "no model turn should start once aborted");
  assert.ok(!events.some((e) => e.type === "text"));
});

test("runAgent propagates a fatal model-stream failure to the caller", async () => {
  const request = await makeRequest();
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    // eslint-disable-next-line require-yield
    async *streamTurn() {
      throw new Error("上游连接失败");
    },
  };

  // runAgent does not emit an error AgentEvent itself; the model-turn failure
  // rejects out of the generator and main.ts turns it into an error event.
  // Characterize that contract here so a future refactor keeps it.
  await assert.rejects(
    collect(runAgent("test-req-2", request, new AbortController().signal, deps)),
    /上游连接失败/,
  );
});
