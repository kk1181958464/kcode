import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPausedCompletionResult,
  isAbsoluteModelTurnTimeout,
  isMeaningfulModelTurnTimeout,
  modelTurnTimeoutKind,
} from "./agent-finalization";
import { SseStreamTimeoutError } from "./sse-stream";
import { compactOperationEvidenceResult } from "./coding-operation-verification";
import type { HistoryItem } from "./agent-types";

test("modelTurnTimeoutKind distinguishes meaningful vs absolute", () => {
  assert.equal(
    modelTurnTimeoutKind(new SseStreamTimeoutError("meaningful", 45_000)),
    "meaningful",
  );
  assert.equal(
    modelTurnTimeoutKind(new SseStreamTimeoutError("absolute", 480_000)),
    "absolute",
  );
  assert.equal(
    isMeaningfulModelTurnTimeout(
      new Error("模型连续只输出思考内容，未返回正文或工具调用。"),
    ),
    true,
  );
  assert.equal(
    isAbsoluteModelTurnTimeout(
      new Error("模型单轮响应超过安全时限，已暂停等待。"),
    ),
    true,
  );
  assert.equal(
    isMeaningfulModelTurnTimeout(
      new Error("模型单轮响应超过安全时限，已暂停等待。"),
    ),
    false,
  );
});

test("buildPausedCompletionResult omits plan:pending when requires evidence is satisfied", () => {
  const history: HistoryItem[] = [
    {
      kind: "calls",
      calls: [
        {
          id: "write-1",
          name: "write_file",
          input: { path: "hello.txt", content: "hi\n" },
        },
      ],
      rawCalls: [],
    },
    compactOperationEvidenceResult("write-1", "write_file", true, {
      changed: true,
      path: "hello.txt",
      output: "written",
      operationEvidence: ["modify"],
    }) as HistoryItem,
  ];
  const result = buildPausedCompletionResult({
    evidenceHistory: history,
    baselineCodingEvidence: new Set(),
    requestedCodingEvidenceOps: new Set(["modify"]),
    requestedBrowserOps: new Set(),
    requestedGitOps: new Set(),
    plannerExecutionPending: false,
    planRequirementsPending: false,
    // Caller incorrectly claims plan pending (stale statuses); evidence wins.
    planPending: true,
    planSteps: ["修改文件"],
    planStatuses: ["in_progress"],
    planRequirements: [["modify"]],
    pauseReason: "stream-timeout",
  });
  assert.equal(result.missingOperations.includes("plan:pending"), false);
  assert.equal(result.missingOperations.includes("coding:modify"), false);
  assert.equal(result.kind, "incomplete");
  assert.match(result.notice ?? "", /单轮安全边界/);
  assert.doesNotMatch(result.notice ?? "", /未检测到/);
});

test("buildPausedCompletionResult still lists unmet plan requires on timeout pause", () => {
  const result = buildPausedCompletionResult({
    evidenceHistory: [],
    baselineCodingEvidence: new Set(),
    requestedCodingEvidenceOps: new Set(["modify"]),
    requestedBrowserOps: new Set(),
    requestedGitOps: new Set(),
    plannerExecutionPending: false,
    planPending: true,
    planSteps: ["修改文件"],
    planStatuses: ["pending"],
    planRequirements: [["modify"]],
    pauseReason: "stream-timeout",
  });
  assert.ok(result.missingOperations.includes("coding:modify"));
  assert.ok(result.missingOperations.includes("plan:pending"));
  assert.equal(result.kind, "incomplete");
  assert.match(result.notice ?? "", /单轮安全边界/);
});
