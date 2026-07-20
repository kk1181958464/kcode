import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedGitOperations,
  requestedGitOperations,
  successfulGitEvidence,
} from "./git-operation-verification";

test("detects requested and claimed Git release operations", () => {
  assert.deepEqual(
    [...requestedGitOperations([
      {
        kind: "message",
        role: "user",
        content: "提交到 GitHub 并触发打包",
      },
    ])],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [...claimedGitOperations("已提交并推送，Release 工作流已触发")],
    ["commit", "push", "release"],
  );
});

test("requires successful tool results as Git evidence", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "commit",
        name: "run_command",
        input: { command: "git commit -m test" },
      },
      {
        id: "push",
        name: "run_command",
        input: { command: "git push origin main" },
      },
      {
        id: "release",
        name: "run_command",
        input: { command: "gh run view 123" },
      },
    ],
  };
  const evidence = successfulGitEvidence([
    calls,
    { kind: "result", callId: "commit", content: '{"success":true}' },
    { kind: "result", callId: "push", content: '{"success":false}' },
    { kind: "result", callId: "release", content: '{"success":true}' },
  ]);
  assert.deepEqual([...evidence], ["commit", "release"]);
});

test("model text and legacy results never count as execution evidence", () => {
  assert.deepEqual(
    [...successfulGitEvidence([
      {
        kind: "message",
        role: "assistant",
        content: "已提交 571a852 并触发打包",
      },
      {
        kind: "calls",
        calls: [
          {
            id: "push",
            name: "run_command",
            input: { command: "git push" },
          },
        ],
      },
      { kind: "result", callId: "push", content: "命令执行成功" },
    ])],
    [],
  );
});
