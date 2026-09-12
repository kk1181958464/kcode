import assert from "node:assert/strict";
import test from "node:test";
import { defaultStreamTurn } from "./model-stream-runner";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { UpstreamHttpError } from "./request-guard";
import { SseStreamTimeoutError } from "./sse-stream";
import type { ModelStreamFn, Turn, TurnStreamEvent } from "./agent-types";

function args(): Parameters<ModelStreamFn>[0] {
  return {
    root: process.cwd(),
    requestId: "stream-fixture",
    request: {
      workspacePath: process.cwd(),
      providerId: "fixture",
      modelId: "fixture",
      permissionMode: "full-access",
      messages: [],
    },
    history: [],
    signal: new AbortController().signal,
    toolsEnabled: true,
    requireToolCall: false,
    runtime: {
      activeSkills: "",
      provider: {
        id: "fixture",
        name: "Fixture",
        protocol: "openai-chat",
        baseUrl: "https://example.invalid",
        enabled: true,
        apiKey: "fixture",
        models: [],
      },
    },
    attemptBudget: new ModelAttemptBudget(3),
  };
}
const turn: Turn = {
  text: "Updated result",
  calls: [],
  rawCalls: [],
  usage: { input: 1, output: 1, cached: 0 },
};

test("a divergent stream retry replaces partial text once and shares the turn deadline", async () => {
  const request = args();
  const events: TurnStreamEvent[] = [];
  const deadlines: Array<number | undefined> = [];
  let attempt = 0;
  for await (const event of defaultStreamTurn(
    request,
    async (...parameters) => {
      request.attemptBudget.acquire();
      deadlines.push(parameters[13]);
      const onText = parameters[7];
      if (++attempt === 1) {
        onText?.("Initial fragment");
        throw new UpstreamHttpError(503, "fixture", 0);
      }
      onText?.(turn.text);
      return turn;
    },
  ))
    events.push(event);
  assert.equal(attempt, 2);
  assert.equal(deadlines[0], deadlines[1]);
  assert.ok(deadlines[0]);
  let visible = "";
  for (const event of events) {
    if (event.type === "text") visible += event.delta;
    if (event.type === "text_reset") visible = event.replacement ?? "";
  }
  assert.equal(visible, turn.text);
  assert.equal(events.filter((event) => event.type === "complete").length, 1);
  assert.equal(request.attemptBudget.attemptsUsed, 2);
});

test("an absolute timeout preserves partial output and never emits completion", async () => {
  const events: TurnStreamEvent[] = [];
  let attempts = 0;
  await assert.rejects(async () => {
    for await (const event of defaultStreamTurn(
      args(),
      async (...parameters) => {
        attempts++;
        parameters[7]?.("Partial result");
        throw new SseStreamTimeoutError("absolute", 1);
      },
    ))
      events.push(event);
  }, SseStreamTimeoutError);
  assert.equal(attempts, 1);
  assert.ok(
    events.some(
      (event) => event.type === "text" && event.delta === "Partial result",
    ),
  );
  assert.ok(!events.some((event) => event.type === "complete"));
});
