import assert from "node:assert/strict";
import test from "node:test";
import { readSseJson } from "./sse-stream";

const encode = (value: string) => new TextEncoder().encode(value);

async function collect(response: Response, terminalGraceMs = 20) {
  const events: any[] = [];
  for await (const event of readSseJson(response, {
    signal: new AbortController().signal,
    idleTimeoutMs: 50,
    terminalGraceMs,
  }))
    events.push(event);
  return events;
}

test("finishes on a Responses terminal event even when cancel never settles", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('data: {"type":"response.completed"}\n\n'));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const result = await Promise.race([
    collect(new Response(body)),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 100),
    ),
  ]);
  assert.notEqual(result, "timeout");
  assert.equal((result as any[])[0].type, "response.completed");
});

test("finishes on Chat finish_reason while the relay keeps sending heartbeats", async () => {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
      );
      heartbeat = setInterval(() => {
        controller.enqueue(encode(": keepalive\n\n"));
      }, 5);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  const result = await Promise.race([
    collect(new Response(body)),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 100),
    ),
  ]);
  assert.notEqual(result, "timeout");
  assert.equal((result as any[])[0].choices[0].finish_reason, "stop");
});

test("keeps a short grace period for the OpenAI usage chunk", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
      );
      setTimeout(() => {
        controller.enqueue(
          encode(
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n',
          ),
        );
        controller.enqueue(encode("data: [DONE]\n\n"));
      }, 5);
    },
  });
  // Keep the test grace well below production's 750 ms while allowing for the
  // Node test runner executing many files concurrently on Windows.
  const events = await collect(new Response(body), 100);
  assert.equal(events.length, 3);
  assert.equal(events[1].usage.prompt_tokens, 10);
  assert.equal(events[2].type, "__sse_done");
});

test("surfaces a Responses failure event without waiting for EOF", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode(
          'data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n',
        ),
      );
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const events = await collect(new Response(body));
  assert.equal(events[0].type, "response.failed");
});

test("finishes on Anthropic and Gemini protocol terminal events", async () => {
  for (const payload of [
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { candidates: [{ finishReason: "STOP", content: { parts: [] } }] },
  ]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(`data: ${JSON.stringify(payload)}\n\n`));
      },
    });
    const events = await collect(new Response(body));
    assert.deepEqual(events, [payload]);
  }
});

test("semantic idle timeout is not kept alive by SSE comments", async () => {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        controller.enqueue(encode(": keepalive\n\n"));
      }, 5);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  await assert.rejects(collect(new Response(body)), /没有有效事件|没有新数据/);
});

test("parses a final event without a trailing SSE blank line", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('data: {"type":"response.completed"}'));
      controller.close();
    },
  });
  const events = await collect(new Response(body));
  assert.equal(events[0].type, "response.completed");
});

test("classifies a truncated final SSE JSON event as an interrupted stream", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode('data: {"choices":[{"delta":{"content":"half"}}]'),
      );
      controller.close();
    },
  });
  await assert.rejects(
    collect(new Response(body)),
    /模型响应流意外中断（SSE 事件 JSON 不完整/,
  );
});

test("parses UTF-8 SSE events split across arbitrary transport chunks", async () => {
  const source = encode(
    'data: {"choices":[{"delta":{"content":"读取完成"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const sizes = [1, 2, 7, 3, 11, 5, 13];
      let offset = 0;
      let index = 0;
      while (offset < source.length) {
        const size = sizes[index++ % sizes.length];
        controller.enqueue(source.slice(offset, offset + size));
        offset += size;
      }
      controller.close();
    },
  });
  const events = await collect(new Response(body));
  assert.equal(events[0].choices[0].delta.content, "读取完成");
  assert.equal(events[1].choices[0].finish_reason, "stop");
});

test("joins multi-line SSE data fields before parsing JSON", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encode(
          'data: {"choices":\n' +
            'data: [{"delta":{},"finish_reason":"stop"}]}\n\n',
        ),
      );
      controller.close();
    },
  });
  const events = await collect(new Response(body));
  assert.equal(events[0].choices[0].finish_reason, "stop");
});
