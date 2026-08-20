import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithRetry,
  readStreamChunk,
  retryAfterMilliseconds,
} from "./request-guard";
import { ModelAttemptBudget } from "./model-attempt-budget";

test("retries one transient upstream response", async () => {
  let attempts = 0;
  const response = await fetchWithRetry(
    "https://provider.example/v1/messages",
    { method: "POST" },
    {
      signal: new AbortController().signal,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        attempts += 1;
        return new Response(attempts === 1 ? "upstream failed" : "ok", {
          status: attempts === 1 ? 502 : 200,
        });
      }) as typeof fetch,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test("retries rate limits and reports retry progress", async () => {
  let attempts = 0;
  const progress: string[] = [];
  const response = await fetchWithRetry(
    "https://provider.example/v1/messages",
    { method: "POST" },
    {
      signal: new AbortController().signal,
      retryDelayMs: 0,
      onProgress: (message) => progress.push(message),
      fetchImpl: (async () => {
        attempts += 1;
        return new Response(attempts === 1 ? "rate limited" : "ok", {
          status: attempts === 1 ? 429 : 200,
          headers: attempts === 1 ? { "retry-after": "0" } : undefined,
        });
      }) as typeof fetch,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.match(progress.join("\n"), /上游返回 429/);
});

test("parses Retry-After seconds and dates with a bounded delay", () => {
  const now = Date.parse("2026-08-20T00:00:00Z");
  assert.equal(
    retryAfterMilliseconds(
      new Response("", { headers: { "retry-after": "12" } }),
      60_000,
      now,
    ),
    12_000,
  );
  assert.equal(
    retryAfterMilliseconds(
      new Response("", {
        headers: { "retry-after": "Thu, 20 Aug 2026 00:02:00 GMT" },
      }),
      60_000,
      now,
    ),
    60_000,
  );
  assert.equal(
    retryAfterMilliseconds(new Response(""), 60_000, now),
    undefined,
  );
});

test("retries a first-byte timeout before failing", async () => {
  let attempts = 0;
  const pendingFetch = ((_input: string, init?: RequestInit) => {
    attempts += 1;
    if (attempts === 2) return Promise.resolve(new Response("ok"));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
  const response = await fetchWithRetry(
    "https://provider.example/v1/messages",
    { method: "POST" },
    {
      signal: new AbortController().signal,
      firstByteTimeoutMs: 10,
      retryDelayMs: 0,
      retries: 1,
      fetchImpl: pendingFetch,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test("fails when the model does not return response headers in time", async () => {
  const pendingFetch = ((_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  await assert.rejects(
    fetchWithRetry(
      "https://provider.example/v1/messages",
      { method: "POST" },
      {
        signal: new AbortController().signal,
        firstByteTimeoutMs: 15,
        retries: 0,
        fetchImpl: pendingFetch,
      },
    ),
    /等待响应超时/,
  );
});

test("fails and cancels a model stream after an idle timeout", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const reader = stream.getReader();
  await assert.rejects(
    readStreamChunk(reader, new AbortController().signal, 15),
    /响应流长时间没有新数据/,
  );
  assert.equal(cancelled, true);
});

test("does not multiply retries across calls sharing one model budget", async () => {
  const budget = new ModelAttemptBudget(3);
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response("unavailable", { status: 502 });
  }) as typeof fetch;
  for (let call = 0; call < 2; call += 1)
    await fetchWithRetry(
      "https://provider.example/v1/messages",
      { method: "POST" },
      {
        signal: new AbortController().signal,
        retries: 1,
        retryDelayMs: 0,
        attemptBudget: budget,
        fetchImpl,
      },
    );
  assert.equal(attempts, 3);
  assert.equal(budget.remaining, 0);
  await assert.rejects(
    fetchWithRetry(
      "https://provider.example/v1/messages",
      { method: "POST" },
      {
        signal: new AbortController().signal,
        attemptBudget: budget,
        fetchImpl,
      },
    ),
    /重试预算/,
  );
});
