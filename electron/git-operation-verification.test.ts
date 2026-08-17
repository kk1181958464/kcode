import assert from "node:assert/strict";
import test from "node:test";
import {
  gitOperationsRequiredByCalls,
  missingRequestedGitOperations,
  successfulGitEvidence,
  unavailableGitOperations,
} from "./git-operation-verification";

test("derives Git requirements only from executable tool calls", () => {
  assert.deepEqual(
    [
      ...gitOperationsRequiredByCalls([
        {
          name: "run_command",
          input: {
            command:
              "git commit -m test; git push origin main; gh workflow run package.yml",
          },
        },
      ]),
    ],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [
      ...gitOperationsRequiredByCalls([
        { name: "read_file", input: { command: "git push" } },
      ]),
    ],
    [],
  );
});

test("unwraps shell commands but ignores Git words passed to output commands", () => {
  assert.deepEqual(
    [
      ...gitOperationsRequiredByCalls([
        {
          name: "run_command",
          input: {
            command:
              'powershell -NoProfile -Command "git -C repo commit -m test; git push"',
          },
        },
      ]),
    ],
    ["commit", "push"],
  );
  for (const command of [
    'Write-Output "git commit; git push"',
    'echo "gh workflow run package.yml"',
  ])
    assert.deepEqual(
      [
        ...gitOperationsRequiredByCalls([
          { name: "run_command", input: { command } },
        ]),
      ],
      [],
      command,
    );
});

test("requires successful structured results as Git evidence", () => {
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
        id: "trigger",
        name: "run_command",
        input: { command: "gh workflow run package.yml" },
      },
      {
        id: "verify",
        name: "run_command",
        input: { command: "gh run view 123" },
      },
    ],
  };
  const evidence = successfulGitEvidence([
    calls,
    { kind: "result", callId: "commit", content: '{"success":true}' },
    { kind: "result", callId: "push", content: '{"success":true}' },
    { kind: "result", callId: "trigger", content: '{"success":true}' },
    { kind: "result", callId: "verify", content: '{"success":true}' },
  ]);
  assert.deepEqual([...evidence], ["commit", "push", "release"]);
});

test("failed and legacy results cannot prove Git mutations", () => {
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
        input: { command: "git push" },
      },
    ],
  };
  assert.deepEqual(
    [
      ...successfulGitEvidence([
        { kind: "message", role: "assistant", content: "已提交并推送" },
        calls,
        { kind: "result", callId: "commit", content: "提交成功" },
        { kind: "result", callId: "push", content: '{"success":false}' },
      ]),
    ],
    [],
  );
});

test("accepts successful Git operations executed through SSH", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "commit",
        name: "ssh_run",
        input: { command: "git commit -m release" },
      },
      {
        id: "push",
        name: "ssh_run",
        input: { command: "git push origin main" },
      },
      {
        id: "verify",
        name: "ssh_run",
        input: { command: "gh run watch 123" },
      },
    ],
  };
  assert.deepEqual(
    [
      ...successfulGitEvidence([
        calls,
        { kind: "result", callId: "commit", content: '{"success":true}' },
        { kind: "result", callId: "push", content: '{"success":true}' },
        { kind: "result", callId: "verify", content: '{"success":true}' },
      ]),
    ],
    ["commit", "push", "release"],
  );
});

test("uses only actual Git commands when detecting repository blockers", () => {
  const failure = JSON.stringify({
    success: false,
    data: { output: "fatal: not a git repository (or any parent)" },
  });
  assert.deepEqual(
    [
      ...unavailableGitOperations([
        {
          kind: "calls",
          calls: [
            {
              id: "probe",
              name: "ssh_run",
              input: { command: "git status --short --branch" },
            },
          ],
        },
        { kind: "result", callId: "probe", content: failure },
      ]),
    ],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [
      ...unavailableGitOperations([
        {
          kind: "calls",
          calls: [
            {
              id: "echo",
              name: "ssh_run",
              input: { command: 'Write-Output "git status"' },
            },
          ],
        },
        { kind: "result", callId: "echo", content: failure },
      ]),
    ],
    [],
  );
});

test("reports missing Git evidence", () => {
  assert.deepEqual(
    missingRequestedGitOperations(
      new Set(["commit", "push", "release"]),
      new Set(["commit"]),
    ),
    ["push", "release"],
  );
});
