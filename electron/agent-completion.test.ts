import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentCompletionResult } from "./agent-completion";
import {
  compactOperationEvidenceResult,
  structuredToolEvidenceSummary,
  type CodingVerificationHistoryItem,
} from "./coding-operation-verification";
import { requiredEvidenceHook } from "./stop-hooks";

const emptyEvidence = {
  toolCalls: 0,
  successfulTools: 0,
  failedTools: 0,
  changedFiles: [],
  additions: 0,
  deletions: 0,
};

test("plain answers complete without tool evidence", () => {
  const result = buildAgentCompletionResult({
    requestedOperations: [],
    observedOperations: [],
    missingOperations: [],
    evidence: emptyEvidence,
    waitingForUser: false,
    verifiedNoChange: false,
  });

  assert.equal(result.kind, "answer");
  assert.equal(result.notice, undefined);
});

test("missing runtime evidence is incomplete rather than a failed claim", () => {
  const result = buildAgentCompletionResult({
    requestedOperations: ["coding:modify", "coding:validate"],
    observedOperations: [],
    missingOperations: ["coding:modify", "coding:validate"],
    evidence: emptyEvidence,
    waitingForUser: false,
    verifiedNoChange: false,
  });

  assert.equal(result.kind, "incomplete");
  assert.match(result.notice ?? "", /实际修改/);
  assert.match(result.notice ?? "", /修改后验证/);
});

test("accepts an already-connected managed SSH session as connection evidence", () => {
  const result = buildAgentCompletionResult({
    requestedOperations: ["coding:connect", "coding:modify", "coding:validate"],
    observedOperations: ["coding:connect", "coding:modify", "coding:validate"],
    missingOperations: [],
    evidence: {
      ...emptyEvidence,
      toolCalls: 2,
      successfulTools: 2,
      changedFiles: ["remote.php"],
      additions: 3,
      deletions: 1,
    },
    waitingForUser: false,
    verifiedNoChange: false,
  });

  assert.equal(result.kind, "changed");
  assert.deepEqual(result.missingOperations, []);
});

test("completion evidence is derived from successful structured tool results", () => {
  const history: CodingVerificationHistoryItem[] = [
    {
      kind: "calls",
      calls: [
        {
          id: "write-1",
          name: "write_file",
          input: { path: "src/a.ts" },
        },
      ],
    },
    compactOperationEvidenceResult("write-1", "write_file", true, {
      changed: true,
      path: "src/a.ts",
      additions: 4,
      deletions: 1,
    }),
  ];

  assert.deepEqual(structuredToolEvidenceSummary(history), {
    toolCalls: 1,
    successfulTools: 1,
    failedTools: 0,
    changedFiles: ["src/a.ts"],
    additions: 4,
    deletions: 1,
  });
});

test("required evidence hook retries once without inspecting assistant text", () => {
  const context = {
    requestedOperations: ["coding:modify"],
    observedOperations: [],
    missingOperations: ["coding:modify"],
    waitingForUser: false,
  };

  assert.equal(
    requiredEvidenceHook.evaluate({ ...context, retryCount: 0 }).action,
    "continue",
  );
  assert.deepEqual(
    requiredEvidenceHook.evaluate({ ...context, retryCount: 1 }),
    { action: "allow" },
  );
  assert.deepEqual(
    requiredEvidenceHook.evaluate({
      ...context,
      retryCount: 0,
      missingOperations: [],
    }),
    { action: "allow" },
  );
});
