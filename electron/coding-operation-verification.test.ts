import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedCodingOperations,
  requestedCodingOperations,
  shouldRequireCodingTool,
  successfulCodingEvidence,
} from "./coding-operation-verification";

test("detects coding work requested and falsely claimed by a text-only reply", () => {
  assert.deepEqual(
    [...requestedCodingOperations([
      { kind: "message", role: "user", content: "整体检查 UI，然后开始修改并验证构建" },
    ])],
    ["inspect", "modify", "validate"],
  );
  assert.deepEqual(
    [...claimedCodingOperations(
      "已完成检查和改造。修改文件：src/App.tsx。类型检查、92 项测试和生产构建通过。",
    )],
    ["inspect", "modify", "validate"],
  );
});

test("requires structured successful tool results as coding evidence", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        { id: "read", name: "read_file", input: { path: "src/App.tsx" } },
        { id: "edit", name: "apply_patch", input: { patch: "..." } },
        { id: "test", name: "diagnostics", input: { kind: "test" } },
      ],
    },
    { kind: "result" as const, callId: "read", content: '{"success":true}' },
    { kind: "result" as const, callId: "edit", content: '{"success":false}' },
    { kind: "result" as const, callId: "test", content: '{"success":true}' },
  ];
  assert.deepEqual([...successfulCodingEvidence(history)], ["inspect", "validate"]);
});

test("assistant prose and legacy outputs are not execution evidence", () => {
  assert.deepEqual(
    [...successfulCodingEvidence([
      { kind: "message", role: "assistant", content: "已经修改完成" },
      {
        kind: "calls",
        calls: [{ id: "edit", name: "write_file", input: { path: "a.ts" } }],
      },
      { kind: "result", callId: "edit", content: "修改成功" },
    ])],
    [],
  );
});

test("requires Kimi K3 to make the first tool call for explicit coding work", () => {
  const requested = new Set(["inspect", "modify"] as const);
  assert.equal(shouldRequireCodingTool("kimi-k3", requested, new Set()), true);
  assert.equal(
    shouldRequireCodingTool("kimi-k3", requested, new Set(["inspect"])),
    true,
  );
  assert.equal(
    shouldRequireCodingTool(
      "kimi-k3",
      requested,
      new Set(["inspect", "modify"]),
    ),
    false,
  );
  assert.equal(shouldRequireCodingTool("gpt-5.6-sol", requested, new Set()), false);
  assert.equal(shouldRequireCodingTool("kimi-k3", new Set(), new Set()), false);
});