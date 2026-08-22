import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, resolveApproval, type RunAgentDeps } from "./agent";
import type { AgentEvent, ModelRequest } from "../src/types";
import { UpstreamHttpError } from "./request-guard";

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
      models: [
        { id: modelId, modelId, displayName: modelId, protocol: "openai-chat" },
      ],
      apiKey: "sk-fake",
      apiKeys: ["sk-fake"],
    }) as any;
}

async function makeRequest(): Promise<ModelRequest> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-runagent-"),
  );
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
  assert.ok(
    types.includes("text"),
    `expected a text event, got ${types.join(",")}`,
  );
  assert.ok(
    types.includes("final_response"),
    "expected a final_response event",
  );
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "expected a done event");
  assert.equal((done as any).outcome, "completed");
  assert.equal(
    (done as Extract<AgentEvent, { type: "done" }>).result?.kind,
    "answer",
  );

  const answer = events
    .filter((e) => e.type === "text")
    .map((e) => (e as any).delta)
    .join("");
  assert.match(answer, /编码 Agent/);
});

test("request_user_input blocks immediately without another model round", async () => {
  const request = await makeRequest();
  request.messages = [
    {
      role: "user",
      content: "扫描完成后，只让我选择要卸载的软件，不要自行删除。",
    },
  ];
  let rounds = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      rounds += 1;
      assert.equal(
        rounds,
        1,
        "waiting for user input must end the current run",
      );
      yield {
        type: "complete",
        turn: {
          text: "扫描已经完成，需要你确认卸载范围。",
          calls: [
            {
              id: "request-uninstall-selection",
              name: "request_user_input",
              input: {
                question: "请选择需要卸载的软件编号，我会保留未选择的软件。",
                fields: ["要卸载的软件编号，例如 5、6"],
              },
            },
          ],
          rawCalls: [],
          usage: { input: 14, output: 8, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent(
      "test-request-user-input-terminal",
      request,
      new AbortController().signal,
      deps,
    ),
  );

  assert.equal(rounds, 1);
  const successfulInputActivities = events.filter(
    (event): event is Extract<AgentEvent, { type: "activity" }> =>
      event.type === "activity" &&
      event.activity.tool === "request_user_input" &&
      event.activity.status === "success",
  );
  assert.equal(
    new Set(successfulInputActivities.map((event) => event.activity.id)).size,
    1,
  );
  assert.match(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "text" }> =>
          event.type === "text" && event.phase === "final_answer",
      )
      .map((event) => event.delta)
      .join(""),
    /请选择需要卸载的软件编号[\s\S]*要卸载的软件编号，例如 5、6/,
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "blocked");
  assert.equal(done?.result?.kind, "blocked");
  assert.equal(done?.result?.toolCalls, 1);
  assert.equal(done?.result?.successfulTools, 1);
  assert.match(done?.result?.notice ?? "", /补充上述信息/);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("runAgent publishes update_plan as structured activity state", async () => {
  const request = await makeRequest();
  await writeFile(
    path.join(request.workspacePath, "notes.txt"),
    "structured plans\n",
    "utf8",
  );
  request.messages = [
    { role: "user", content: "检查 notes.txt，并按计划给出结论" },
  ];
  let round = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      round += 1;
      if (round === 1) {
        yield {
          type: "complete",
          turn: {
            text: "开始按结构化计划检查。",
            calls: [
              {
                id: "plan",
                name: "update_plan",
                input: {
                  explanation: "先读取，再总结",
                  plan: [
                    { step: "读取目标文件", status: "in_progress" },
                    { step: "汇总检查结论", status: "pending" },
                  ],
                },
              },
              {
                id: "read",
                name: "read_file",
                input: { path: "notes.txt" },
              },
            ],
            rawCalls: [],
            usage: { input: 12, output: 5, cached: 0 },
          },
        };
        return;
      }
      yield { type: "text", delta: "检查完成，文件内容正常。" };
      yield {
        type: "complete",
        turn: {
          text: "检查完成，文件内容正常。",
          calls: [],
          rawCalls: [],
          usage: { input: 18, output: 8, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent("test-structured-plan", request, new AbortController().signal, deps),
  );
  const planActivity = events.find(
    (event): event is Extract<AgentEvent, { type: "activity" }> =>
      event.type === "activity" && event.activity.tool === "update_plan",
  )?.activity;
  assert.deepEqual(planActivity?.planSteps, ["读取目标文件", "汇总检查结论"]);
  assert.deepEqual(planActivity?.planStatuses, ["in_progress", "pending"]);
  assert.equal(
    events.find((event) => event.type === "done")?.type,
    "done",
  );
});

test("runAgent answers the latest explanation instead of an older upload goal", async () => {
  const request = await makeRequest();
  request.messages = [
    { role: "user", content: "把构建文件上传到 SSH 服务器" },
    { role: "assistant", content: "上传尚未完成。" },
    {
      role: "user",
      content: "需要说明为什么手机端需要 app，电脑端网页就可以",
    },
  ];
  const requireToolCall: boolean[] = [];
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn(args) {
      requireToolCall.push(args.requireToolCall);
      yield {
        type: "text",
        delta: "手机端通常需要 App，是为了后台保活、系统权限和原生通知。",
      };
      yield {
        type: "complete",
        turn: {
          text: "手机端通常需要 App，是为了后台保活、系统权限和原生通知。",
          calls: [],
          rawCalls: [],
          usage: { input: 20, output: 12, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent(
      "test-latest-explanation",
      request,
      new AbortController().signal,
      deps,
    ),
  );
  assert.deepEqual(requireToolCall, [false]);
  assert.ok(!events.some((event) => event.type === "text_reset"));
  assert.ok(!events.some((event) => event.type === "error"));
  assert.ok(
    events.findIndex((event) => event.type === "text") <
      events.findIndex((event) => event.type === "final_response"),
    "an informational answer should stream before it is marked final",
  );
  assert.match(
    events
      .filter((event) => event.type === "text")
      .map((event) => (event as Extract<AgentEvent, { type: "text" }>).delta)
      .join(""),
    /后台保活/,
  );
});

test("assistant action wording cannot force an informational turn into verification", async () => {
  const request = await makeRequest();
  request.messages = [
    {
      role: "user",
      content: "为什么手机端需要 app，电脑端网页就可以？",
    },
  ];
  let round = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      round += 1;
      const text = "文件已经上传成功，任务已完成。";
      yield { type: "text", delta: text };
      yield {
        type: "complete",
        turn: {
          text,
          calls: [],
          rawCalls: [],
          usage: { input: 20, output: 12, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent(
      "test-buffer-inspection",
      request,
      new AbortController().signal,
      deps,
    ),
  );
  const streamedText = events
    .filter((event) => event.type === "text")
    .map((event) => (event as Extract<AgentEvent, { type: "text" }>).delta)
    .join("");
  const finalResponse = events.find(
    (event): event is Extract<AgentEvent, { type: "final_response" }> =>
      event.type === "final_response",
  );
  assert.equal(round, 1);
  assert.match(streamedText, /上传成功/);
  assert.equal(finalResponse?.textOffset, 0);
  assert.equal(finalResponse?.processKind, undefined);
  assert.ok(!events.some((event) => event.type === "text_reset"));
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.result?.kind, "answer");
  assert.deepEqual(done?.result?.operations, []);
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
        yield { type: "text", delta: "已创建。" };
        yield {
          type: "complete",
          turn: {
            text: "已创建。",
            calls: [],
            rawCalls: [],
            usage: { input: 20, output: 6, cached: 0 },
          },
        };
      }
    },
  };

  const reqId = "test-req-confirm";
  const events: AgentEvent[] = [];
  let approved = false;
  for await (const event of runAgent(
    reqId,
    request,
    new AbortController().signal,
    deps,
  )) {
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
  const written = await readFile(
    path.join(request.workspacePath, "hello.txt"),
    "utf8",
  );
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
  const requiredToolCalls: boolean[] = [];
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn(args) {
      requiredToolCalls.push(args.requireToolCall);
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
  assert.equal(
    (done as Extract<AgentEvent, { type: "done" }>).result?.kind,
    "changed",
  );
  assert.deepEqual(
    (done as Extract<AgentEvent, { type: "done" }>).result?.changedFiles,
    ["hello.txt"],
  );

  const written = await readFile(
    path.join(request.workspacePath, "hello.txt"),
    "utf8",
  );
  assert.equal(written, "hi\n");
  assert.deepEqual(requiredToolCalls, [false, false]);
});

test("runAgent accepts backend query conclusions without Git or browser correction loops", async () => {
  const request = await makeRequest();
  request.messages = [
    {
      role: "user",
      content: "看一下生图记录id为9067 为什么没有返回id",
    },
  ];
  const conclusion =
    "查清楚了：记录 9067 未返回 ID。因为这条记录已经超过提交有效时间。已输入记录 ID 9067，提交数据库查询并确认返回结果为空。";
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
                id: "call_inspect",
                name: "list_directory",
                input: { path: "." },
              },
            ],
            rawCalls: [],
            usage: { input: 12, output: 4, cached: 0 },
          },
        };
        return;
      }
      if (round > 2)
        throw new Error(
          "business wording incorrectly entered a verification loop",
        );
      yield { type: "text", delta: conclusion };
      yield {
        type: "complete",
        turn: {
          text: conclusion,
          calls: [],
          rawCalls: [],
          usage: { input: 20, output: 16, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent(
      "test-backend-query-conclusion",
      request,
      new AbortController().signal,
      deps,
    ),
  );
  assert.equal(round, 2);
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => (event as Extract<AgentEvent, { type: "text" }>).delta)
      .join(""),
    conclusion,
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
});

test("runAgent keeps an existing capability inventory as the final answer", async () => {
  const request = await makeRequest();
  request.messages = [
    {
      role: "user",
      content: "看下已经实现的功能和需求文档还有哪些差别",
    },
  ];
  const conclusion =
    "当前系统已经具备课程和考试主流程。已实现全员、部门和岗位课程范围，已有录屏分片上传；但培训档案、证书和消息仍未实现。";
  let rounds = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      rounds += 1;
      if (rounds > 1)
        throw new Error("capability inventory incorrectly entered verification");
      yield { type: "text", delta: conclusion };
      yield {
        type: "complete",
        turn: {
          text: conclusion,
          calls: [],
          rawCalls: [],
          usage: { input: 20, output: 16, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent(
      "test-capability-inventory",
      request,
      new AbortController().signal,
      deps,
    ),
  );
  assert.equal(rounds, 1);
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => (event as Extract<AgentEvent, { type: "text" }>).delta)
      .join(""),
    conclusion,
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("runAgent never infers missing runtime evidence from user or model prose", async () => {
  const request = await makeRequest();
  request.messages = [
    { role: "user", content: "把 README.md 里的标题改成 Hello" },
  ];
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
  assert.equal(streamCalls, 1);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "text_reset"), false);
  assert.equal(
    events
      .filter((event) => event.type === "text")
      .map((event) => (event as Extract<AgentEvent, { type: "text" }>).delta)
      .join(""),
    "已完成修改。",
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "completed");
  assert.equal(done?.result?.kind, "answer");
  assert.deepEqual(done?.result?.missingOperations, []);
});

test("runAgent retries a side effect after its actual tool call fails", async () => {
  const request = await makeRequest();
  request.messages = [{ role: "user", content: "处理这个任务" }];
  let streamCalls = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      streamCalls += 1;
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
  };

  const events = await collect(
    runAgent("test-tool-evidence-retry", request, new AbortController().signal, deps),
  );
  assert.equal(streamCalls, 3);
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(done?.outcome, "paused");
  assert.equal(done?.result?.kind, "incomplete");
  assert.ok(done?.result?.missingOperations.includes("coding:modify"));
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
        turn: {
          text: "不该发生",
          calls: [],
          rawCalls: [],
          usage: { input: 0, output: 0, cached: 0 },
        },
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

test("runAgent text resets retain the text before the current model turn", async () => {
  const request = await makeRequest();
  const prefix = "先检查工作区。";
  let round = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      round += 1;
      if (round === 1) {
        yield { type: "text", delta: prefix };
        yield {
          type: "complete",
          turn: {
            text: prefix,
            calls: [
              {
                id: "call_list",
                name: "list_directory",
                input: { path: "." },
              },
            ],
            rawCalls: [],
            usage: { input: 8, output: 4, cached: 0 },
          },
        };
        return;
      }
      yield { type: "text", delta: "旧结论。" };
      yield { type: "text_reset" };
      yield { type: "text", delta: "新结论。" };
      yield {
        type: "complete",
        turn: {
          text: "新结论。",
          calls: [],
          rawCalls: [],
          usage: { input: 12, output: 5, cached: 0 },
        },
      };
    },
  };

  const events = await collect(
    runAgent("test-req-reset", request, new AbortController().signal, deps),
  );
  const reset = events.find((event) => event.type === "text_reset");
  assert.ok(reset, "expected a text_reset event");
  assert.equal(reset.textOffset, prefix.length);
  assert.equal(reset.reason, "stream_retry");
  assert.ok(
    events.some(
      (event) =>
        event.type === "activity" &&
        event.activity.textOffset === prefix.length,
    ),
    "expected the preceding activity to use the same timeline offset",
  );
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
    collect(
      runAgent("test-req-2", request, new AbortController().signal, deps),
    ),
    /上游连接失败/,
  );
});

test("runAgent pauses and preserves completed tool evidence after a late gateway failure", async () => {
  const request = await makeRequest();
  let streamCalls = 0;
  const deps: RunAgentDeps = {
    getProvider: fakeProvider("fake-model"),
    async *streamTurn() {
      streamCalls += 1;
      if (streamCalls === 1) {
        yield {
          type: "complete",
          turn: {
            text: "先检查工作区。",
            calls: [
              {
                id: "list-before-gateway-failure",
                name: "list_directory",
                input: { path: "." },
              },
            ],
            rawCalls: [],
            usage: { input: 8, output: 4, cached: 0 },
          },
        };
        return;
      }
      throw new UpstreamHttpError(502, "bad gateway");
    },
  };

  const events = await collect(
    runAgent(
      "test-late-gateway-pause",
      request,
      new AbortController().signal,
      deps,
    ),
  );
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "done" }> =>
      event.type === "done",
  );
  assert.equal(streamCalls, 2);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(done?.outcome, "paused");
  assert.equal(done?.result?.kind, "incomplete");
  assert.equal(done?.result?.successfulTools, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "text" && event.delta.includes("已有工具结果均已保留"),
    ),
  );
});
