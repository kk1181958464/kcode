import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentEvent, ModelRequest } from "../src/types";
import {
  runAgent,
  resolveApproval,
  steerAgent,
  type RunAgentDeps,
} from "./agent";
import { approvals } from "./agent-approval";
import type { ToolCall, TurnStreamEvent } from "./agent-types";
import { turnSteeringQueue } from "./turn-steering";

const getProvider: RunAgentDeps["getProvider"] = async () =>
  ({
    id: "fixture",
    name: "Fixture",
    protocol: "openai-chat",
    enabled: true,
    baseUrl: "https://example.invalid",
    apiKey: "fixture",
    apiKeys: ["fixture"],
    models: [
      {
        id: "fixture",
        modelId: "fixture",
        displayName: "Fixture",
        protocol: "openai-chat",
      },
    ],
  }) as never;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-stability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request: ModelRequest = {
    workspacePath: root,
    providerId: "fixture",
    modelId: "fixture",
    permissionMode: "full-access",
    messages: [{ role: "user", content: "查看任务状态" }],
  };
  return {
    root,
    request,
    requestId: path.basename(root),
    controller: new AbortController(),
  };
}

function turn(text: string, calls: ToolCall[] = []): TurnStreamEvent {
  return {
    type: "complete",
    turn: {
      text,
      calls,
      rawCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
    },
  };
}

async function collect(
  run: AsyncGenerator<AgentEvent>,
  receive?: (event: AgentEvent) => void,
) {
  const events: AgentEvent[] = [];
  for await (const event of run) {
    events.push(structuredClone(event));
    receive?.(event);
  }
  return events;
}

function completed(events: AgentEvent[]) {
  const terminal = events.filter(
    (event) => event.type === "done" || event.type === "error",
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "done");
  if (terminal[0].type === "done")
    assert.equal(terminal[0].outcome, "completed");
}

const plan = [
  {
    step: "修改并验证文件",
    status: "completed" as const,
    requires: ["modify" as const, "validate" as const],
  },
];

test(
  "a recovered completed plan requires revalidation after a fresh edit",
  { timeout: 15_000 },
  async (t) => {
    const { request, requestId, controller, root } = await fixture(t);
    await writeFile(path.join(root, "result.js"), "const value = 1;\n");
    request.recoveryPlan = {
      steps: plan,
      current: 0,
      requirementsDeclared: true,
    };
    request.recoveryEvidence = {
      coding: ["inspect", "modify", "execute", "validate"],
      browser: [],
      git: [],
    };
    let rounds = 0;
    const events = await collect(
      runAgent(requestId, request, controller.signal, {
        getProvider,
        async *streamTurn(args) {
          rounds++;
          if (rounds === 1) {
            yield turn("", [
              {
                id: "edit",
                name: "write_file",
                input: { path: "result.js", content: "const value = 2;\n" },
              },
            ]);
          } else if (rounds === 2) {
            assert.equal(
              args.toolsEnabled,
              true,
              "recovered validation cannot authorize finalization after a new edit",
            );
            assert.ok(
              args.history.some(
                (item) =>
                  item.kind === "message" &&
                  item.content.includes("补一次只读核验"),
              ),
            );
            yield turn("", [
              {
                id: "check",
                name: "run_command",
                input: {
                  command: "node --check result.js",
                  purpose: "validate",
                },
              },
            ]);
          } else {
            assert.equal(rounds, 3);
            assert.equal(args.toolsEnabled, false);
            yield turn("修改和重新核验均已完成。");
          }
        },
      }),
    );
    assert.equal(rounds, 3);
    completed(events);
    assert.equal(
      events.filter(
        (e) =>
          e.type === "activity" &&
          e.activity.tool === "write_file" &&
          e.activity.status === "success",
      ).length,
      1,
    );
  },
);

for (const timing of ["model", "final_response", "final_answer"] as const) {
  test(`steering accepted during ${timing} is handled before completion`, async (t) => {
    const { request, requestId, controller } = await fixture(t);
    let rounds = 0;
    let steered = false;
    const steer = () => {
      steerAgent(requestId, "补充说明验证结果");
      steered = true;
    };
    const events = await collect(
      runAgent(requestId, request, controller.signal, {
        getProvider,
        async *streamTurn(args) {
          rounds++;
          if (rounds === 1) {
            if (timing === "model") steer();
            yield turn("原回复");
          } else {
            assert.equal(rounds, 2);
            assert.equal(
              args.history.filter(
                (item) =>
                  item.kind === "message" &&
                  item.content === "<user_steer>补充说明验证结果</user_steer>",
              ).length,
              1,
            );
            yield turn("已补充验证结果。");
          }
        },
      }),
      (event) => {
        if (
          !steered &&
          (event.type === timing ||
            (timing === "final_answer" &&
              event.type === "text" &&
              event.phase === "final_answer"))
        )
          steer();
        if (event.type === "done")
          assert.throws(() => steerAgent(requestId, "迟到指令"), /任务已结束/);
      },
    );
    assert.equal(rounds, 2);
    completed(events);
    assert.equal(turnSteeringQueue.size(requestId), 0);
    assert.ok(
      events.some((e) => e.type === "text" && e.delta === "已补充验证结果。"),
    );
  });
}

test("steering during evidence finalization re-enables tools without repeating old work", async (t) => {
  const { request, requestId, controller, root } = await fixture(t);
  request.recoveryPlan = {
    steps: plan,
    current: 0,
    requirementsDeclared: true,
  };
  request.recoveryEvidence = {
    coding: ["modify", "validate"],
    browser: [],
    git: [],
  };
  let rounds = 0;
  let steered = false;
  const events = await collect(
    runAgent(requestId, request, controller.signal, {
      getProvider,
      async *streamTurn(args) {
        rounds++;
        if (rounds === 1)
          yield turn("", [
            { id: "plan", name: "update_plan", input: { plan } },
          ]);
        else if (rounds === 2) {
          assert.equal(args.toolsEnabled, false);
          yield turn("上一项已完成。");
        } else if (rounds === 3) {
          assert.equal(args.toolsEnabled, true);
          yield turn("", [
            {
              id: "extra",
              name: "write_file",
              input: { path: "extra.txt", content: "extra" },
            },
          ]);
        } else {
          assert.equal(rounds, 4);
          yield turn("追加文件已创建。");
        }
      },
    }),
    (event) => {
      if (!steered && event.type === "final_response") {
        steered = true;
        steerAgent(requestId, "再创建 extra.txt");
      }
    },
  );
  completed(events);
  assert.equal(rounds, 4);
  assert.equal(await readFile(path.join(root, "extra.txt"), "utf8"), "extra");
  assert.equal(
    events.filter(
      (e) =>
        e.type === "activity" &&
        e.activity.tool === "write_file" &&
        e.activity.status === "success",
    ).length,
    1,
  );
});

test("steering can resume a transport pause before its terminal event", async (t) => {
  const { request, requestId, controller } = await fixture(t);
  let rounds = 0;
  let steered = false;
  const events = await collect(
    runAgent(requestId, request, controller.signal, {
      getProvider,
      async *streamTurn() {
        rounds++;
        if (rounds === 1)
          throw new Error("Internal error during token generation");
        assert.equal(rounds, 2);
        yield turn("已响应新指令。");
      },
    }),
    (event) => {
      if (!steered && event.type === "text" && event.phase === "final_answer") {
        steered = true;
        steerAgent(requestId, "请继续说明");
      }
    },
  );
  completed(events);
  assert.equal(rounds, 2);
  const finalStart = events.filter((e) => e.type === "final_response").at(-1);
  assert.equal(
    finalStart?.textOffset,
    events
      .filter((e) => e.type === "text")
      .slice(0, -1)
      .reduce((sum, e) => sum + e.delta.length, 0),
  );
});

test("an answer received while emitting a question clears the waiting-for-user state", async (t) => {
  const { request, requestId, controller } = await fixture(t);
  let rounds = 0;
  let steered = false;
  const events = await collect(
    runAgent(requestId, request, controller.signal, {
      getProvider,
      async *streamTurn() {
        rounds++;
        if (rounds === 1)
          yield turn("", [
            {
              id: "question",
              name: "request_user_input",
              input: {
                question: "请问这次说明使用什么语言？",
                fields: ["language"],
              },
            },
          ]);
        else {
          assert.equal(rounds, 2);
          yield turn("已用中文说明。");
        }
      },
    }),
    (event) => {
      if (!steered && event.type === "final_response") {
        steered = true;
        steerAgent(requestId, "用中文");
      }
    },
  );
  completed(events);
  assert.equal(rounds, 2);
  assert.notEqual(
    events.find((e) => e.type === "done")?.result?.kind,
    "blocked",
  );
});

test("cancellation during finalization wins over queued steering", async (t) => {
  const { request, requestId, controller } = await fixture(t);
  let rounds = 0;
  const events = await collect(
    runAgent(requestId, request, controller.signal, {
      getProvider,
      async *streamTurn() {
        rounds++;
        yield turn("原回复");
      },
    }),
    (event) => {
      if (event.type === "final_response") {
        steerAgent(requestId, "追加指令");
        controller.abort();
      }
    },
  );
  assert.equal(rounds, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 1);
  assert.equal(
    events.some((e) => e.type === "done"),
    false,
  );
  assert.throws(() => steerAgent(requestId, "迟到指令"), /任务已结束/);
});

for (const ending of ["closed", "failed"] as const) {
  test(`steering is cleaned up when the generator is ${ending}`, async (t) => {
    const { request, requestId, controller } = await fixture(t);
    const run = runAgent(requestId, request, controller.signal, {
      getProvider,
      async *streamTurn() {
        throw new Error("fixture fatal error");
      },
    });
    await run.next();
    steerAgent(requestId, "待处理指令");
    if (ending === "closed") await run.return(undefined);
    else
      await assert.rejects(async () => {
        for await (const _ of run) {
          /* drain */
        }
      }, /fixture fatal error/);
    assert.equal(turnSteeringQueue.size(requestId), 0);
    assert.throws(() => steerAgent(requestId, "迟到指令"), /任务已结束/);
  });
}

for (const decision of ["approve", "cancel"] as const) {
  test(
    `plan confirmation handles immediate ${decision} without leaking or executing after cancellation`,
    { timeout: 5_000 },
    async (t) => {
      const { request, requestId, controller, root } = await fixture(t);
      request.collaboration = { mode: "plan-confirm" };
      let rounds = 0;
      let prompted = false;
      const events = await collect(
        runAgent(requestId, request, controller.signal, {
          getProvider,
          async *streamTurn() {
            rounds++;
            if (rounds === 1)
              yield turn("", [
                {
                  id: "plan",
                  name: "update_plan",
                  input: {
                    plan: [
                      {
                        step: "创建文件",
                        status: "in_progress",
                        requires: ["modify"],
                      },
                    ],
                  },
                },
                {
                  id: "write",
                  name: "write_file",
                  input: { path: "approved.txt", content: "approved" },
                },
                {
                  id: "complete-plan",
                  name: "update_plan",
                  input: {
                    plan: [
                      {
                        step: "创建文件",
                        status: "completed",
                        requires: ["modify"],
                      },
                    ],
                  },
                },
              ]);
            else {
              assert.equal(rounds, 2);
              yield turn("完成。");
            }
          },
        }),
        (event) => {
          if (
            event.type === "activity" &&
            event.activity.status === "waiting"
          ) {
            prompted = true;
            if (decision === "approve")
              resolveApproval(requestId, event.activity.id, true);
            else controller.abort();
          }
        },
      );
      assert.ok(prompted);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(
        [...approvals.keys()].some((key) => key.startsWith(`${requestId}:`)),
        false,
      );
      if (decision === "approve") {
        assert.equal(
          await readFile(path.join(root, "approved.txt"), "utf8"),
          "approved",
        );
        completed(events);
      } else {
        await assert.rejects(readFile(path.join(root, "approved.txt")), {
          code: "ENOENT",
        });
        assert.equal(events.filter((e) => e.type === "error").length, 1);
        assert.equal(rounds, 1);
      }
    },
  );
}
