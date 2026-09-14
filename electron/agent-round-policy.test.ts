import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCompletionResult, AgentPlanRequirement } from "../src/types";
import type { ToolCall } from "./agent-types";
import { MAX_PLAN_RECOVERY_NUDGES } from "./agent-finalization";
import { createRunState, type RunPlan } from "./agent-run-state";
import {
  SEMANTIC_STALL_ROUNDS,
  STALL_FINALIZATION_ROUNDS,
  STALL_RECOVERY_ROUNDS,
  VALIDATION_STALL_ROUNDS,
} from "./agent-stall-policy";
import {
  applyRoundStallCounters,
  applyRunCompletionNotices,
  autoContinueProgressMessage,
  autoContinueVerificationContent,
  buildRoundEvidenceSnapshot,
  classifyToolRoundProgress,
  completionOperationKeys,
  EMPTY_TURN_RETRY_CONTENT,
  emptyTurnRecovery,
  streamTimeoutRecovery,
  STREAM_TIMEOUT_RECOVERY_CONTENT,
  finalizationHistoryContent,
  finalizationProgressMessage,
  finalizationRoleLabel,
  isTruncatedFinishReason,
  nextExternalWaitStall,
  noToolAutoContinue,
  pendingPlanStepLabel,
  planRecoveryContent,
  REASONING_ONLY_RETRY_CONTENT,
  REPETITION_RECOVERY_CONTENT,
  roundStallDecision,
  runDoneOutcome,
  stallFinalizeProgressMessage,
  type RoundEvidenceSnapshot,
} from "./agent-round-policy";

const emptyPlan: RunPlan = {
  steps: [],
  statuses: undefined,
  requirements: [] as AgentPlanRequirement[][],
  cursor: 0,
  requirementsDeclared: true,
};

const snapshotInput = (
  overrides: Partial<Parameters<typeof buildRoundEvidenceSnapshot>[0]> = {},
) => ({
  plannerCoordinator: false,
  plan: emptyPlan,
  requestedCodingEvidenceOps: new Set<"modify">(),
  requestedBrowserOps: new Set<"open">(),
  requestedGitOps: new Set<"commit">(),
  codingEvidence: new Set<"modify">(),
  browserEvidence: new Set<"open">(),
  gitEvidence: new Set<"commit">(),
  unavailableGit: new Set<"commit">(),
  successfulTools: new Set<string>(),
  evidenceHistory: [],
  hasUncollectedAgentWork: false,
  ...overrides,
});

const call = (name: ToolCall["name"], command?: string): ToolCall => ({
  id: "call-1",
  name,
  input: command ? { command } : {},
});

const completeSnapshot = (
  overrides: Partial<RoundEvidenceSnapshot> = {},
): RoundEvidenceSnapshot => ({
  plannerExecutionPending: false,
  planRequirementsPending: false,
  pendingRequiredPlanStep: -1,
  nextRequiredPlanStep: -1,
  missingCodingOperations: [],
  missingActionCodingOperations: [],
  missingBrowserOperations: [],
  missingGitOperations: [],
  missingAvailableGitOperations: [],
  actionablePlanPending: false,
  evidenceComplete: true,
  planCompleted: true,
  hasMutationEvidence: true,
  ...overrides,
});

test("buildRoundEvidenceSnapshot marks planner spawn, plan requirements and missing ops", () => {
  const snapshot = buildRoundEvidenceSnapshot(
    snapshotInput({
      plannerCoordinator: true,
      plan: {
        steps: ["plan", "execute"],
        statuses: ["completed", "in_progress"],
        requirements: [[], ["modify"]],
        cursor: 1,
        requirementsDeclared: false,
      },
      requestedCodingEvidenceOps: new Set(["modify", "inspect"]),
      requestedBrowserOps: new Set(["open"]),
      requestedGitOps: new Set(["commit", "push"]),
      codingEvidence: new Set(["inspect"]),
      browserEvidence: new Set(),
      gitEvidence: new Set(),
      unavailableGit: new Set(["push"]),
      successfulTools: new Set(),
    }),
  );
  assert.equal(snapshot.plannerExecutionPending, true);
  assert.equal(snapshot.planRequirementsPending, true);
  assert.equal(snapshot.pendingRequiredPlanStep, 1);
  assert.deepEqual(snapshot.missingActionCodingOperations, ["modify"]);
  assert.deepEqual(snapshot.missingBrowserOperations, ["open"]);
  assert.deepEqual(snapshot.missingGitOperations, ["commit", "push"]);
  assert.deepEqual(snapshot.missingAvailableGitOperations, ["commit"]);
  assert.equal(snapshot.actionablePlanPending, true);
  assert.equal(snapshot.evidenceComplete, false);
  assert.equal(snapshot.planCompleted, false);
  assert.equal(snapshot.hasMutationEvidence, false);
});

test("single-step collaboration plans still require an executor", () => {
  const pending = buildRoundEvidenceSnapshot(
    snapshotInput({
      plannerCoordinator: true,
      plan: {
        steps: ["落实修改并验证"],
        statuses: ["pending"],
        requirements: [["modify", "validate"]],
        cursor: 0,
        requirementsDeclared: true,
      },
      successfulTools: new Set(),
    }),
  );
  assert.equal(pending.plannerExecutionPending, true);
  const spawned = buildRoundEvidenceSnapshot(
    snapshotInput({
      plannerCoordinator: true,
      plan: {
        steps: ["落实修改并验证"],
        statuses: ["in_progress"],
        requirements: [["modify", "validate"]],
        cursor: 0,
        requirementsDeclared: true,
      },
      successfulTools: new Set(["spawn_agent"]),
      hasUncollectedAgentWork: true,
    }),
  );
  assert.equal(spawned.plannerExecutionPending, false);
  assert.equal(spawned.evidenceComplete, false);
});

test("declared completed plan steps are not complete without tool evidence", () => {
  const snapshot = buildRoundEvidenceSnapshot(
    snapshotInput({
      plan: {
        steps: ["修改文件", "验证"],
        statuses: ["completed", "completed"],
        requirements: [["modify"], ["validate"]],
        cursor: 1,
        requirementsDeclared: true,
      },
      requestedCodingEvidenceOps: new Set(),
      requestedBrowserOps: new Set(),
      requestedGitOps: new Set(),
      codingEvidence: new Set(),
      browserEvidence: new Set(),
      gitEvidence: new Set(),
      unavailableGit: new Set(),
    }),
  );
  assert.equal(snapshot.planCompleted, false);
  assert.equal(snapshot.planStatusesCompleted, true);
  assert.equal(snapshot.pendingRequiredPlanStep, 0);
  assert.equal(snapshot.nextRequiredPlanStep, 0);
  assert.equal(snapshot.actionablePlanPending, true);
  assert.equal(snapshot.evidenceComplete, false);
});

test("a plan is complete only after required tool evidence exists", () => {
  const snapshot = buildRoundEvidenceSnapshot(
    snapshotInput({
      plan: {
        steps: ["修改文件", "验证"],
        statuses: ["completed", "completed"],
        requirements: [["modify"], ["validate"]],
        cursor: 1,
        requirementsDeclared: true,
      },
      requestedCodingEvidenceOps: new Set(["modify", "validate"]),
      requestedBrowserOps: new Set(),
      requestedGitOps: new Set(),
      codingEvidence: new Set(["modify", "validate"]),
      browserEvidence: new Set(),
      gitEvidence: new Set(),
      unavailableGit: new Set(),
    }),
  );
  assert.equal(snapshot.planCompleted, true);
  assert.equal(snapshot.pendingRequiredPlanStep, -1);
  assert.equal(snapshot.evidenceComplete, true);
});


test("incomplete plan statuses keep the turn actionable without reading prose", () => {
  const snapshot = buildRoundEvidenceSnapshot(
    snapshotInput({
      plan: {
        steps: ["查账号", "统计请求", "核对日志"],
        statuses: ["completed", "pending", "pending"],
        requirements: [["inspect"], ["inspect"], ["inspect"]],
        cursor: 1,
        requirementsDeclared: true,
      },
      requestedCodingEvidenceOps: new Set(["inspect"]),
      requestedBrowserOps: new Set(),
      requestedGitOps: new Set(),
      // Global inspect already happened, but later plan steps are still pending.
      codingEvidence: new Set(["inspect"]),
      browserEvidence: new Set(),
      gitEvidence: new Set(),
      unavailableGit: new Set(),
    }),
  );
  assert.equal(snapshot.actionablePlanPending, true);
  assert.equal(snapshot.evidenceComplete, false);
});

test("plan auto-continue allows several structured nudges", () => {
  const once = noToolAutoContinue({
    hasCalls: false,
    plannerCoordinator: false,
    plannerExecutionPending: false,
    requestedUserInput: false,
    actionablePlanPending: true,
    autoContinues: 1,
  });
  assert.equal(once.willAutoContinue, true);
  const exhausted = noToolAutoContinue({
    hasCalls: false,
    plannerCoordinator: false,
    plannerExecutionPending: false,
    requestedUserInput: false,
    actionablePlanPending: true,
    autoContinues: 4,
  });
  assert.equal(exhausted.willAutoContinue, false);
});

test("buildRoundEvidenceSnapshot is complete when remaining git ops are unavailable", () => {
  const snapshot = buildRoundEvidenceSnapshot(
    snapshotInput({
      requestedCodingEvidenceOps: new Set(["modify"]),
      requestedBrowserOps: new Set(["open"]),
      requestedGitOps: new Set(["push"]),
      codingEvidence: new Set(["modify"]),
      browserEvidence: new Set(["open"]),
      gitEvidence: new Set(),
      unavailableGit: new Set(["push"]),
      successfulTools: new Set(["spawn_agent"]),
    }),
  );
  assert.equal(snapshot.evidenceComplete, true);
  assert.equal(snapshot.hasMutationEvidence, true);
  assert.equal(snapshot.actionablePlanPending, false);
});

test("completionOperationKeys uses action coding and available git only for missing", () => {
  const snapshot = completeSnapshot({
    plannerExecutionPending: true,
    planRequirementsPending: true,
    pendingRequiredPlanStep: 0,
    missingActionCodingOperations: ["modify"],
    missingBrowserOperations: ["open"],
    missingAvailableGitOperations: ["commit"],
  });
  const keys = completionOperationKeys({
    requestedCodingEvidenceOps: ["inspect", "modify"],
    requestedBrowserOps: ["open"],
    requestedGitOps: ["commit"],
    codingEvidence: ["inspect"],
    browserEvidence: [],
    gitEvidence: [],
    spawnedExecutor: false,
    snapshot,
  });
  assert.deepEqual(keys.requestedOperations, [
    "coding:inspect",
    "coding:modify",
    "browser:open",
    "git:commit",
    "agent:spawn_executor",
    "plan:requirements",
    "plan:pending",
  ]);
  assert.deepEqual(keys.observedOperations, ["coding:inspect"]);
  assert.deepEqual(keys.missingOperations, [
    "coding:modify",
    "browser:open",
    "git:commit",
    "agent:spawn_executor",
    "plan:requirements",
    "plan:pending",
  ]);
});

test("applyRunCompletionNotices and runDoneOutcome preserve pause vs complete", () => {
  const complete: AgentCompletionResult = {
    kind: "answer",
    operations: [],
    missingOperations: [],
    toolCalls: 0,
    successfulTools: 0,
    failedTools: 0,
    changedFiles: [],
    additions: 0,
    deletions: 0,
  };
  const fallbackIncomplete = applyRunCompletionNotices(complete, {
    usedRuntimeFinalizationFallback: true,
    evidenceComplete: false,
    externalWorkAbandoned: false,
  });
  assert.equal(fallbackIncomplete.kind, "incomplete");
  const fallbackComplete = applyRunCompletionNotices(complete, {
    usedRuntimeFinalizationFallback: true,
    evidenceComplete: true,
    externalWorkAbandoned: false,
  });
  assert.equal(fallbackComplete.kind, "answer");
  assert.equal(fallbackComplete.notice, "已根据实际工具记录生成本轮摘要。");
  const abandoned = applyRunCompletionNotices(complete, {
    usedRuntimeFinalizationFallback: false,
    evidenceComplete: true,
    externalWorkAbandoned: true,
  });
  assert.equal(abandoned.kind, "incomplete");
  assert.equal(runDoneOutcome({ waitingForUser: true, completionKind: "answer" }), "blocked");
  assert.equal(
    runDoneOutcome({
      waitingForUser: false,
      finalizationMode: "limit-reached",
      completionKind: "answer",
    }),
    "completed",
  );
  assert.equal(
    runDoneOutcome({
      waitingForUser: false,
      finalizationMode: "limit-reached",
      completionKind: "incomplete",
    }),
    "paused",
  );
  assert.equal(
    runDoneOutcome({ waitingForUser: false, completionKind: "incomplete" }),
    "paused",
  );
  assert.equal(
    runDoneOutcome({ waitingForUser: false, completionKind: "answer" }),
    "completed",
  );
});

test("finalization copy distinguishes planner, executor and abandoned subagents", () => {
  assert.equal(finalizationRoleLabel("planner"), "规划模型");
  assert.equal(finalizationRoleLabel("executor"), "执行模型");
  assert.equal(finalizationRoleLabel(), "当前任务");
  assert.match(
    finalizationProgressMessage("evidence-complete", "planner") ?? "",
    /规划模型已完成主要修改/,
  );
  assert.match(
    finalizationHistoryContent("evidence-complete", "planner", false),
    /不要再派发新的执行 Agent/,
  );
  assert.match(
    finalizationHistoryContent("repetition-stalled", undefined, true),
    /部分子 Agent 已因连续无进展被停止/,
  );
  assert.match(
    finalizationHistoryContent("limit-reached", "executor", false),
    /执行 Agent 已达到运行预算上限/,
  );
});

test("noToolAutoContinue covers truncation, pause and unfinished plans", () => {
  assert.equal(isTruncatedFinishReason("max_tokens"), true);
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      finishReason: "length",
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 0,
    }).willAutoContinue,
    true,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      finishReason: "pause_turn",
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 0,
    }).pausedOrIncomplete,
    true,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      plannerCoordinator: true,
      plannerExecutionPending: true,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 0,
    }).collaborationPlanPending,
    true,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: true,
      autoContinues: 0,
    }).executionPlanPending,
    true,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      finishReason: "length",
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 1,
    }).willAutoContinue,
    false,
  );
  assert.match(
    autoContinueProgressMessage({
      truncated: false,
      collaborationPlanPending: false,
      executionPlanPending: true,
      planRequirementsPending: true,
    }),
    /完整要求声明或/,
  );
  assert.match(
    autoContinueVerificationContent({
      truncated: false,
      collaborationPlanPending: false,
      planRequirementsPending: false,
      missingActionCodingOperations: ["modify"],
    }),
    /仍缺少 modify/,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 0,
    }).willAutoContinue,
    false,
  );
});

test("a no-tool round never auto-continues from assistant wording", () => {
  assert.equal(
    noToolAutoContinue({
      hasCalls: false,
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: false,
      autoContinues: 0,
    }).willAutoContinue,
    false,
  );
  assert.equal(
    noToolAutoContinue({
      hasCalls: true,
      plannerCoordinator: false,
      plannerExecutionPending: false,
      requestedUserInput: false,
      actionablePlanPending: true,
      autoContinues: 0,
    }).willAutoContinue,
    false,
  );
});

test("emptyTurnRecovery retries then pauses, errors or abandons subagents", () => {
  assert.equal(
    emptyTurnRecovery({
      hasText: true,
      hasCalls: false,
      hasReasoning: false,
      reasoningOnlyTurns: 0,
      emptyTurns: 0,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: false,
    }),
    undefined,
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: true,
      reasoningOnlyTurns: 0,
      emptyTurns: 0,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: false,
    }),
    { action: "retry-reasoning" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: true,
      reasoningOnlyTurns: 1,
      emptyTurns: 0,
      hasUncollectedAgentWork: true,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: true,
    }),
    { action: "abandon-subagents" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: true,
      reasoningOnlyTurns: 1,
      emptyTurns: 0,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: true,
    }),
    { action: "pause-reasoning" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: true,
      reasoningOnlyTurns: 1,
      emptyTurns: 0,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: false,
    }),
    { action: "error-reasoning" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: false,
      reasoningOnlyTurns: 0,
      emptyTurns: 1,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: false,
    }),
    { action: "error-empty" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: false,
      reasoningOnlyTurns: 0,
      emptyTurns: 1,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: true,
    }),
    { action: "pause-empty" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: false,
      reasoningOnlyTurns: 0,
      emptyTurns: 1,
      hasUncollectedAgentWork: true,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: true,
    }),
    { action: "abandon-subagents" },
  );
  assert.deepEqual(
    emptyTurnRecovery({
      hasText: false,
      hasCalls: false,
      hasReasoning: false,
      reasoningOnlyTurns: 0,
      emptyTurns: 0,
      hasUncollectedAgentWork: false,
      externalWorkAbandoned: false,
      hasRecoverableToolEvidence: false,
    }),
    { action: "retry-empty", attempt: 1 },
  );
  assert.match(REASONING_ONLY_RETRY_CONTENT, /只返回了内部思考/);
  assert.match(EMPTY_TURN_RETRY_CONTENT, /空响应/);
  assert.match(REPETITION_RECOVERY_CONTENT, /不要再次原样重试/);
});

test("streamTimeoutRecovery auto-continues meaningful mid-task timeouts once", () => {
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "meaningful",
      hasRecoverableToolEvidence: true,
      unfinishedWork: true,
      streamTimeoutRecoveries: 0,
    }),
    { action: "auto-continue" },
  );
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "meaningful",
      hasRecoverableToolEvidence: true,
      unfinishedWork: true,
      streamTimeoutRecoveries: 1,
    }),
    { action: "pause" },
  );
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "absolute",
      hasRecoverableToolEvidence: true,
      unfinishedWork: true,
      streamTimeoutRecoveries: 0,
    }),
    { action: "pause" },
  );
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "meaningful",
      hasRecoverableToolEvidence: false,
      unfinishedWork: true,
      streamTimeoutRecoveries: 0,
    }),
    { action: "pause" },
  );
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "meaningful",
      finalizationMode: "evidence-complete",
      hasRecoverableToolEvidence: true,
      unfinishedWork: true,
      streamTimeoutRecoveries: 0,
    }),
    { action: "pause" },
  );
  assert.deepEqual(
    streamTimeoutRecovery({
      timeoutKind: "meaningful",
      hasRecoverableToolEvidence: true,
      unfinishedWork: false,
      streamTimeoutRecoveries: 0,
    }),
    { action: "pause" },
  );
  assert.match(STREAM_TIMEOUT_RECOVERY_CONTENT, /单轮安全边界/);
});


test("classifyToolRoundProgress treats plan-only and verification-only as non-progress", () => {
  const planOnly = classifyToolRoundProgress({
    calls: [call("update_plan")],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "plan",
    noProgressFingerprints: new Set(),
    planCompleted: true,
    evidenceComplete: true,
    hasMutationEvidence: true,
  });
  assert.equal(planOnly.unchangedPlanMaintenanceRound, true);
  assert.equal(planOnly.nonProgressRound, true);
  assert.equal(planOnly.madeProgress, false);

  const verification = classifyToolRoundProgress({
    calls: [call("read_file")],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "read",
    noProgressFingerprints: new Set(["read"]),
    planCompleted: true,
    evidenceComplete: true,
    hasMutationEvidence: true,
  });
  assert.equal(verification.verificationOnlyRound, true);
  assert.equal(verification.repeatedNoProgressRound, true);
  assert.equal(verification.madeProgress, false);

  const validation = classifyToolRoundProgress({
    calls: [call("diagnostics"), call("run_command", "npm test")],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "validate",
    noProgressFingerprints: new Set(),
    planCompleted: false,
    evidenceComplete: false,
    hasMutationEvidence: false,
  });
  assert.equal(validation.validationOnlyRound, true);

  const purposeValidate = classifyToolRoundProgress({
    calls: [
      {
        id: "echo-check",
        name: "run_command",
        input: { command: "echo stable-check", purpose: "validate" },
      },
    ],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "echo-validate",
    noProgressFingerprints: new Set(),
    planCompleted: false,
    evidenceComplete: false,
    hasMutationEvidence: false,
  });
  assert.equal(purposeValidate.validationOnlyRound, true);
});

test("applyRoundStallCounters and nextExternalWaitStall mutate only stall fields", () => {
  const run = createRunState();
  run.stalledRounds = 2;
  run.semanticStallRounds = 4;
  run.validationStallRounds = 1;
  run.budgets.planRecoveryNudges = 2;
  run.noProgressFingerprints.add("old");
  const noProgress = classifyToolRoundProgress({
    calls: [call("update_plan")],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "plan",
    noProgressFingerprints: run.noProgressFingerprints,
    planCompleted: true,
    evidenceComplete: true,
    hasMutationEvidence: false,
  });
  applyRoundStallCounters(run, noProgress, {
    roundAdvanced: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFingerprint: "plan",
  });
  assert.equal(run.stalledRounds, 3);
  assert.equal(run.semanticStallRounds, 5);
  assert.equal(run.validationStallRounds, 0);
  assert.equal(run.budgets.planRecoveryNudges, 2);
  assert.ok(run.noProgressFingerprints.has("old"));
  assert.ok(run.noProgressFingerprints.has("plan"));

  const advanced = classifyToolRoundProgress({
    calls: [call("write_file")],
    roundAdvanced: true,
    roundOperationalProgress: true,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: true,
    roundFailed: false,
    roundFingerprint: "write",
    noProgressFingerprints: run.noProgressFingerprints,
    planCompleted: false,
    evidenceComplete: false,
    hasMutationEvidence: true,
  });
  applyRoundStallCounters(run, advanced, {
    roundAdvanced: true,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: true,
    roundFingerprint: "write",
  });
  assert.equal(run.stalledRounds, 0);
  assert.equal(run.semanticStallRounds, 0);
  assert.equal(run.budgets.planRecoveryNudges, 0);
  assert.equal(run.noProgressFingerprints.has("old"), false);
  assert.ok(run.noProgressFingerprints.has("write"));

  assert.deepEqual(
    nextExternalWaitStall({
      hasActiveUncollected: false,
      progressed: false,
      stalledRounds: 3,
      startedAt: 10,
    }),
    { stalledRounds: 0, startedAt: undefined },
  );
  assert.deepEqual(
    nextExternalWaitStall({
      hasActiveUncollected: true,
      progressed: true,
      stalledRounds: 3,
      startedAt: 10,
    }),
    { stalledRounds: 0, startedAt: undefined },
  );
  assert.deepEqual(
    nextExternalWaitStall({
      hasActiveUncollected: true,
      progressed: false,
      stalledRounds: 3,
      startedAt: 10,
      now: 99,
    }),
    { stalledRounds: 4, startedAt: 10 },
  );
  assert.deepEqual(
    nextExternalWaitStall({
      hasActiveUncollected: true,
      progressed: false,
      stalledRounds: 0,
      startedAt: undefined,
      now: 42,
    }),
    { stalledRounds: 1, startedAt: 42 },
  );
});

test("roundStallDecision recovers, nudges the plan, then finalizes", () => {
  const run = createRunState();
  const progress = classifyToolRoundProgress({
    calls: [call("read_file")],
    roundAdvanced: false,
    roundOperationalProgress: false,
    roundExternalProgress: false,
    roundWaitingOnExternalWork: false,
    roundPlanChanged: false,
    roundFailed: false,
    roundFingerprint: "read",
    noProgressFingerprints: new Set(["read"]),
    planCompleted: false,
    evidenceComplete: false,
    hasMutationEvidence: false,
  });
  run.stalledRounds = STALL_RECOVERY_ROUNDS;
  assert.equal(
    roundStallDecision({
      state: run,
      progress,
      snapshot: completeSnapshot({
        evidenceComplete: false,
        planCompleted: false,
        hasMutationEvidence: false,
        actionablePlanPending: false,
      }),
      plan: run.plan,
      roundFailed: false,
      pendingUserInput: false,
      hasUncollectedAgentWork: false,
    }).action,
    "recover",
  );

  run.stalledRounds = STALL_FINALIZATION_ROUNDS;
  run.plan = {
    steps: ["fix login"],
    statuses: ["in_progress"],
    requirements: [["modify"]],
    cursor: 0,
    requirementsDeclared: true,
  };
  const recovery = roundStallDecision({
    state: run,
    progress,
    snapshot: completeSnapshot({
      evidenceComplete: false,
      planCompleted: false,
      hasMutationEvidence: false,
      actionablePlanPending: true,
      pendingRequiredPlanStep: 0,
      nextRequiredPlanStep: 0,
      missingActionCodingOperations: ["modify"],
    }),
    plan: run.plan,
    roundFailed: false,
    pendingUserInput: false,
    hasUncollectedAgentWork: false,
  });
  assert.equal(recovery.action, "plan-recovery");
  if (recovery.action === "plan-recovery") {
    assert.equal(recovery.pendingStepLabel, '第 1 步“fix login”');
    assert.deepEqual(recovery.missing, ["modify"]);
  }
  assert.equal(MAX_PLAN_RECOVERY_NUDGES, 3);
  assert.match(
    planRecoveryContent({
      pendingStepLabel: '第 1 步“fix login”',
      planRequirementsPending: false,
      missing: ["modify"],
    }),
    /仍缺少 modify/,
  );
  assert.equal(pendingPlanStepLabel(run.plan, completeSnapshot()), "当前结构化计划");

  run.budgets.planRecoveryNudges = MAX_PLAN_RECOVERY_NUDGES;
  const finalize = roundStallDecision({
    state: run,
    progress,
    snapshot: completeSnapshot({
      evidenceComplete: true,
      planCompleted: true,
      hasMutationEvidence: true,
      actionablePlanPending: true,
    }),
    plan: run.plan,
    roundFailed: false,
    pendingUserInput: false,
    hasUncollectedAgentWork: false,
  });
  assert.equal(finalize.action, "finalize");
  if (finalize.action === "finalize") {
    assert.equal(finalize.mode, "evidence-complete");
    assert.equal(finalize.semanticStallReached, false);
  }

  const completedPlan = roundStallDecision({
    state: run,
    progress: { ...progress, unchangedPlanMaintenanceRound: true },
    snapshot: completeSnapshot(),
    plan: run.plan,
    roundFailed: false,
    pendingUserInput: false,
    hasUncollectedAgentWork: false,
  });
  assert.equal(completedPlan.action, "finalize-completed-plan");

  run.semanticStallRounds = SEMANTIC_STALL_ROUNDS;
  const semantic = roundStallDecision({
    state: run,
    progress,
    snapshot: completeSnapshot({
      evidenceComplete: false,
      planCompleted: false,
      hasMutationEvidence: false,
      actionablePlanPending: false,
    }),
    plan: emptyPlan,
    roundFailed: false,
    pendingUserInput: false,
    hasUncollectedAgentWork: false,
  });
  assert.equal(semantic.action, "finalize");
  if (semantic.action === "finalize") {
    assert.equal(semantic.mode, "repetition-stalled");
    assert.equal(semantic.semanticStallReached, true);
  }
  run.validationStallRounds = VALIDATION_STALL_ROUNDS;
  assert.match(
    stallFinalizeProgressMessage({
      semanticStallReached: true,
      validationStallReached: true,
      validationStallRounds: VALIDATION_STALL_ROUNDS,
      semanticStallRounds: SEMANTIC_STALL_ROUNDS,
      shouldFinalizeAvailableResult: false,
    }),
    /连续 3 轮只有验证/,
  );
});
