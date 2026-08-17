import assert from "node:assert/strict";
import test from "node:test";
import {
  browserOperationsRequiredByCalls,
  missingRequestedBrowserOperations,
  successfulBrowserEvidence,
  type BrowserVerificationHistoryItem,
} from "./browser-operation-verification";

test("derives browser requirements only from actual tool calls", () => {
  assert.deepEqual(
    [
      ...browserOperationsRequiredByCalls([
        { name: "browser_open" },
        { name: "browser_type" },
        { name: "browser_click" },
      ]),
    ],
    ["open", "type", "verify", "click"],
  );
  assert.deepEqual(
    [...browserOperationsRequiredByCalls([{ name: "ssh_connect" }])],
    [],
  );
});

test("requires a fresh snapshot after browser interaction", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "open", name: "browser_open", input: {} },
      { id: "before", name: "browser_snapshot", input: {} },
      { id: "type", name: "browser_type", input: {} },
      { id: "after", name: "browser_snapshot", input: {} },
    ],
  };
  const beforeOnly: BrowserVerificationHistoryItem[] = [
    calls,
    { kind: "result", callId: "open", content: '{"success":true}' },
    { kind: "result", callId: "before", content: '{"success":true}' },
    { kind: "result", callId: "type", content: '{"success":true}' },
  ];
  const beforeEvidence = successfulBrowserEvidence(beforeOnly);
  assert.equal(beforeEvidence.has("open"), true);
  assert.equal(beforeEvidence.has("type"), true);
  assert.equal(beforeEvidence.has("verify"), false);

  const afterEvidence = successfulBrowserEvidence([
    ...beforeOnly,
    { kind: "result", callId: "after", content: '{"success":true}' },
  ]);
  assert.equal(afterEvidence.has("verify"), true);
});

test("ignores assistant prose and unstructured browser results", () => {
  const evidence = successfulBrowserEvidence([
    { kind: "message", role: "assistant", content: "已点击并验证成功" },
    {
      kind: "calls",
      calls: [{ id: "click", name: "browser_click", input: {} }],
    },
    { kind: "result", callId: "click", content: "点击成功" },
  ]);
  assert.deepEqual([...evidence], []);
});

test("carries structured browser evidence from a completed subagent", () => {
  const evidence = successfulBrowserEvidence([
    {
      kind: "calls",
      calls: [{ id: "child", name: "wait_agent", input: {} }],
    },
    {
      kind: "result",
      callId: "child",
      content: JSON.stringify({
        success: true,
        data: { browserOperationEvidence: ["open", "type", "verify"] },
      }),
    },
  ]);
  assert.deepEqual([...evidence], ["open", "type", "verify"]);
});

test("reports missing browser evidence", () => {
  assert.deepEqual(
    missingRequestedBrowserOperations(
      new Set(["open", "type", "click", "verify"]),
      new Set(["open", "type"]),
    ),
    ["click", "verify"],
  );
});
