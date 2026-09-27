import assert from "node:assert/strict";
import test from "node:test";
import { defaultStreamTurn } from "./model-stream-runner";
import { ModelAttemptBudget } from "./model-attempt-budget";
import { UpstreamHttpError } from "./request-guard";
import { SseStreamTimeoutError } from "./sse-stream";
import { FINALIZATION_TURN_MAX_DURATION_MS } from "./model-stream-retry";
import { UpstreamStreamError } from "../src/upstream-stream-error";
import { parseAssembledModelStream } from "./model-stream-assembler";
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
        apiKeys: ["fixture"],
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

test("retries a structured SSE server error even when its message gives no retry hint", async () => {
  const request = args();
  let attempts = 0;
  const events: TurnStreamEvent[] = [];
  for await (const event of defaultStreamTurn(request, async () => {
    request.attemptBudget.acquire();
    if (++attempts === 1)
      return parseAssembledModelStream({
        protocol: "openai-chat",
        response: new Response(
          'data: {"error":{"code":"server_error","message":"opaque failure"}}\n\n',
        ),
        signal: request.signal,
        chatChunkMode: "delta",
        validateCalls: (calls) => calls,
      });
    return turn;
  }))
    events.push(event);
  assert.equal(attempts, 2);
  assert.equal(events.filter((event) => event.type === "complete").length, 1);
});

for (const code of [
  "invalid_api_key",
  "insufficient_quota",
  "context_length_exceeded",
]) {
  test(
    "does not retry structured " + code + " despite temporary-failure wording",
    async () => {
      const request = args();
      let attempts = 0;
      await assert.rejects(
        async () => {
          for await (const _event of defaultStreamTurn(request, async () => {
            attempts++;
            request.attemptBudget.acquire();
            throw new UpstreamStreamError({
              error: { code, message: "upstream temporarily unavailable 503" },
            });
          })) {
            /* drain */
          }
        },
        (error: unknown) =>
          error instanceof UpstreamStreamError && error.code === code,
      );
      assert.equal(attempts, 1);
    },
  );
}

test("retries an SSE token generation error without replaying any tool work", async () => {
  const request = args();
  let attempts = 0;
  const events: TurnStreamEvent[] = [];
  for await (const event of defaultStreamTurn(request, async () => {
    request.attemptBudget.acquire();
    if (++attempts === 1)
      throw new Error("Internal error during token generation");
    return turn;
  }))
    events.push(event);
  assert.equal(attempts, 2);
  assert.equal(events.filter((event) => event.type === "complete").length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.message.includes("正在重试"),
    ),
  );
});

test("limits summary generation to one retry within the shorter deadline", async () => {
  const request = args();
  request.toolsEnabled = false;
  const started = Date.now();
  let attempts = 0;
  const deadlines: Array<number | undefined> = [];
  const events: TurnStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of defaultStreamTurn(
      request,
      async (...parameters) => {
        attempts++;
        request.attemptBudget.acquire();
        deadlines.push(parameters[13]);
        throw new UpstreamHttpError(503, "unavailable", 0);
      },
    ))
      events.push(event);
  }, UpstreamHttpError);
  assert.equal(attempts, 2);
  assert.equal(deadlines[0], deadlines[1]);
  assert.ok(deadlines[0]! >= started + FINALIZATION_TURN_MAX_DURATION_MS);
  assert.ok(deadlines[0]! <= Date.now() + FINALIZATION_TURN_MAX_DURATION_MS);
  assert.ok(!events.some((event) => event.type === "complete"));
});

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

test("recovers an HTTP 200 SSE premature end without replaying text or exposing failed tool calls", async () => {
  const request = args();
  request.history.push(
    {
      kind: "calls",
      calls: [{ id: "already-read", name: "read_file", input: { path: "page.html" } }],
      rawCalls: [],
    },
    { kind: "result", callId: "already-read", content: "previous file content" },
  );
  const historyBefore = structuredClone(request.history);
  const events: TurnStreamEvent[] = [];
  const deadlines: Array<number | undefined> = [];
  let attempts = 0;
  for await (const event of defaultStreamTurn(request, async (...parameters) => {
    request.attemptBudget.acquire();
    deadlines.push(parameters[13]);
    const failed = ++attempts === 1;
    const item = {
      type: "function_call",
      id: failed ? "item-failed" : "item-complete",
      call_id: failed ? "failed-write" : "complete-write",
      name: "write_file",
      arguments: JSON.stringify({
        path: "page.html",
        content: failed ? "discard this attempt" : "<!doctype html><svg></svg>",
      }),
    };
    const payload = [
      { type: "response.output_text.delta", delta: "Creating the standalone HTML." },
      { type: "response.output_item.added", output_index: 0, item },
      ...(failed
        ? [{
            type: "error",
            error: {
              code: "relay_error",
              message: "Upstream stream ended before completion",
            },
          }]
        : [
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { output: [item] } },
          ]),
    ].map((item) => "data: " + JSON.stringify(item) + "\n\n").join("");
    return parseAssembledModelStream({
      protocol: "openai-responses",
      response: new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      signal: parameters[4],
      onText: parameters[7],
      onReasoning: parameters[8],
      chatChunkMode: "delta",
      validateCalls: (calls) => calls,
    });
  })) events.push(event);

  assert.equal(attempts, 2);
  assert.equal(request.attemptBudget.attemptsUsed, 2);
  assert.deepEqual(request.history, historyBefore);
  assert.equal(deadlines[0], deadlines[1]);
  assert.ok(deadlines[0]);
  assert.equal(
    events.filter((event) => event.type === "text").map((event) => event.delta).join(""),
    "Creating the standalone HTML.",
  );
  assert.ok(!events.some((event) => event.type === "text_reset"));
  assert.ok(events.some((event) => event.type === "progress" && event.message.includes("正在重试")));
  const completed = events.filter((event) => event.type === "complete");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].turn.calls, [{
    id: "complete-write",
    name: "write_file",
    input: { path: "page.html", content: "<!doctype html><svg></svg>" },
  }]);
});

test("persistent premature stream ends stop at the request budget and keep partial output", async () => {
  const request = args();
  request.attemptBudget = new ModelAttemptBudget(2);
  const events: TurnStreamEvent[] = [];
  let attempts = 0;
  await assert.rejects(async () => {
    for await (const event of defaultStreamTurn(request, async (...parameters) => {
      attempts++;
      request.attemptBudget.acquire();
      parameters[7]?.("Partial result");
      throw new UpstreamStreamError({
        error: { message: "Upstream stream ended before completion" },
      });
    })) events.push(event);
  }, /Upstream stream ended before completion/);
  assert.equal(attempts, 2);
  assert.equal(request.attemptBudget.attemptsUsed, 2);
  assert.ok(!events.some((event) => event.type === "complete"));
  assert.equal(
    events.filter((event) => event.type === "text").map((event) => event.delta).join(""),
    "Partial result",
  );
});

test("cancelling during premature-end retry backoff does not start another attempt", async () => {
  const request = args();
  const controller = new AbortController();
  request.signal = controller.signal;
  let attempts = 0;
  const events: TurnStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of defaultStreamTurn(request, async () => {
      attempts++;
      request.attemptBudget.acquire();
      throw new Error("Upstream stream ended before completion");
    })) {
      events.push(event);
      if (event.type === "progress") controller.abort();
    }
  }, /Upstream stream ended before completion/);
  assert.ok(events.some((event) => event.type === "progress"));
  assert.equal(attempts, 1);
  assert.ok(!events.some((event) => event.type === "complete"));
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

test("aborts the in-flight model call when the consumer stops early", async () => {
  const request = args();
  let sampleSignal: AbortSignal | undefined;
  const stream = defaultStreamTurn(request, (async (...call: unknown[]) => {
    sampleSignal = call[4] as AbortSignal;
    (call[7] as (text: string) => void)("partial");
    await new Promise((resolve) =>
      sampleSignal!.addEventListener("abort", resolve, { once: true }),
    );
    throw new Error("aborted");
  }) as never);
  const first = await stream.next();
  assert.equal(first.done, false);
  await stream.return(undefined);
  assert.equal(sampleSignal?.aborted, true);
  assert.equal(request.signal.aborted, false);
});
