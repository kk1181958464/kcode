import { test } from "node:test";
import assert from "node:assert";
import { normalizeHistory } from "./history-normalize";

test("deduplicates tool results with same callId (keeps last)", () => {
  const history = [
    { kind: "calls" as const, calls: [{ id: "c1", name: "read_file", input: {} }], rawCalls: [] },
    { kind: "result" as const, callId: "c1", content: "first" },
    { kind: "result" as const, callId: "c1", content: "second (retry)" },
  ];
  const result = normalizeHistory(history);
  const results = result.filter((i) => i.kind === "result");
  assert.equal(results.length, 1);
  assert.equal((results[0] as any).content, "second (retry)");
});

test("prunes orphan results without a matching call", () => {
  const history = [
    { kind: "message" as const, role: "user" as const, content: "hello" },
    { kind: "result" as const, callId: "orphan_id", content: "no matching call" },
    { kind: "message" as const, role: "assistant" as const, content: "hi" },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.length, 2);
  assert.ok(result.every((i) => i.kind === "message"));
});

test("merges consecutive same-role messages", () => {
  const history = [
    { kind: "message" as const, role: "user" as const, content: "part 1" },
    { kind: "message" as const, role: "user" as const, content: "part 2" },
    { kind: "message" as const, role: "assistant" as const, content: "reply" },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.length, 2);
  assert.equal((result[0] as any).content, "part 1\npart 2");
});

test("trims old execution records keeping only recent ones", () => {
  const history = [
    { kind: "message" as const, role: "user" as const, content: "<tool_execution_record>\nTurn 1\n</tool_execution_record>" },
    { kind: "message" as const, role: "assistant" as const, content: "ok" },
    { kind: "message" as const, role: "user" as const, content: "<tool_execution_record>\nTurn 2\n</tool_execution_record>" },
    { kind: "message" as const, role: "assistant" as const, content: "ok" },
    { kind: "message" as const, role: "user" as const, content: "<tool_execution_record>\nTurn 3\n</tool_execution_record>" },
    { kind: "message" as const, role: "assistant" as const, content: "ok" },
    { kind: "message" as const, role: "user" as const, content: "<tool_execution_record>\nTurn 4\n</tool_execution_record>" },
    { kind: "message" as const, role: "assistant" as const, content: "done" },
  ];
  const result = normalizeHistory(history, { maxExecutionRecords: 2 });
  const records = result.filter(
    (i) => i.kind === "message" && (i as any).content.includes("<tool_execution_record>"),
  );
  assert.equal(records.length, 2);
});

test("preserves structural validity (calls followed by results)", () => {
  const history = [
    { kind: "message" as const, role: "user" as const, content: "do it" },
    { kind: "calls" as const, calls: [{ id: "c1", name: "write_file", input: {} }], rawCalls: [] },
    { kind: "result" as const, callId: "c1", content: "done" },
    { kind: "message" as const, role: "assistant" as const, content: "file written" },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.length, 4);
});
