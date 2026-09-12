import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, type RunAgentDeps } from "./agent";
import type { AgentEvent, ModelRequest } from "../src/types";

test("a concurrent task cannot reset another run's file read cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-cache-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "first.txt"), "first task source");
  await writeFile(path.join(root, "second.txt"), "second task source");
  const request: ModelRequest = {
    workspacePath: root,
    providerId: "fixture",
    modelId: "fixture",
    permissionMode: "full-access",
    messages: [
      { role: "user", content: "Read the file and explain its contents." },
    ],
  };
  const provider = {
    id: "fixture",
    name: "Fixture",
    protocol: "openai-chat" as const,
    baseUrl: "https://example.invalid",
    enabled: true,
    apiKey: "fixture",
    apiKeys: ["fixture"],
    models: [
      {
        id: "fixture",
        modelId: "fixture",
        displayName: "Fixture",
        protocol: "openai-chat" as const,
      },
    ],
  };
  let firstRead!: () => void;
  const ready = new Promise<void>((resolve) => {
    firstRead = resolve;
  });
  let release!: () => void;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  function deps(filename: string, repeat: boolean): RunAgentDeps {
    let round = 0;
    return {
      getProvider: async () => provider,
      async *streamTurn() {
        round++;
        if (repeat && round === 2) {
          firstRead();
          await resumed;
        }
        const calls =
          round <= (repeat ? 2 : 1)
            ? [
                {
                  id: filename + round,
                  name: "read_file" as const,
                  input: { path: filename },
                },
              ]
            : [];
        yield {
          type: "complete",
          turn: {
            text: calls.length ? "" : "Reviewed.",
            calls,
            rawCalls: [],
            usage: { input: 1, output: 1, cached: 0 },
          },
        };
      },
    };
  }
  async function collect(id: string, overrides: RunAgentDeps) {
    const events: AgentEvent[] = [];
    for await (const event of runAgent(
      id,
      request,
      new AbortController().signal,
      overrides,
    ))
      events.push(event);
    return events;
  }
  const first = collect("cache-first", deps("first.txt", true));
  await ready;
  try {
    const second = await collect("cache-second", deps("second.txt", false));
    assert.ok(
      second.some(
        (event) =>
          event.type === "activity" &&
          event.activity.output?.includes("second task source"),
      ),
    );
  } finally {
    release();
  }
  const events = await first;
  const reads = events.filter(
    (event) =>
      event.type === "activity" &&
      event.activity.tool === "read_file" &&
      event.activity.status === "success",
  );
  assert.ok(
    reads.some(
      (event) =>
        event.type === "activity" &&
        event.activity.output?.includes("first task source"),
    ),
  );
  assert.ok(
    reads.some(
      (event) =>
        event.type === "activity" &&
        event.activity.output?.includes("[文件未变化]"),
    ),
  );
});
