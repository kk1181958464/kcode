import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, readStreamChunk } from "./request-guard";

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
