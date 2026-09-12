import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecoveryPlan } from "../src/types";
import {
  applyPlanUpdate,
  createRunState,
  resetRunStateAfterSteering,
} from "./agent-run-state";

const recoveryPlan: AgentRecoveryPlan = {
  steps: [
    {
      step: "inspect login",
      status: "completed",
      requires: ["inspect"],
    },
    {
      step: "fix login",
      status: "in_progress",
      requires: ["modify", "validate"],
    },
  ],
  current: 1,
  requirementsDeclared: true,
};

test("createRunState defaults an empty run and leaves plan undeclared-open", () => {
  const run = createRunState();
  assert.equal(run.round, 0);
  assert.equal(run.timelineTextLength, 0);
  assert.equal(run.lastPromptTokens, 0);
  assert.equal(run.lastRuntimeCompactionTokens, 0);
  assert.equal(run.stalledRounds, 0);
  assert.equal(run.semanticStallRounds, 0);
  assert.equal(run.validationStallRounds, 0);
  assert.equal(run.noProgressFingerprints.size, 0);
  assert.deepEqual(run.budgets, {
    completionRetries: 0,
    autoContinues: 0,
    emptyTurns: 0,
    reasoningOnlyTurns: 0,
    planRecoveryNudges: 0,
  });
  assert.deepEqual(run.prevRound, { toolNarrative: "" });
  assert.deepEqual(run.plan, {
    steps: [],
    statuses: undefined,
    requirements: [],
    cursor: 0,
    requirementsDeclared: true,
  });
  assert.equal(run.imageFallbackNoticeSent, false);
  assert.equal(run.repetitionFinalizationPending, undefined);
  assert.equal(run.externalWaitStallRounds, 0);
  assert.equal(run.externalWaitStartedAt, undefined);
  assert.equal(run.externalWorkAbandoned, false);
  assert.equal(run.lastSubagentProgress, "");
  assert.equal(run.requestedCodingEvidenceOps.size, 0);
  assert.equal(run.requestedGitOps.size, 0);
  assert.equal(run.requestedBrowserOps.size, 0);
});

test("createRunState adopts a recovered plan and seeds coding obligations", () => {
  const run = createRunState({
    recoveryPlan,
    lastSubagentProgress: "child-1:running:2:0",
  });
  assert.deepEqual(run.plan.steps, ["inspect login", "fix login"]);
  assert.deepEqual(run.plan.statuses, ["completed", "in_progress"]);
  assert.deepEqual(run.plan.requirements, [
    ["inspect"],
    ["modify", "validate"],
  ]);
  assert.equal(run.plan.cursor, 1);
  assert.equal(run.plan.requirementsDeclared, true);
  assert.deepEqual(
    [...run.requestedCodingEvidenceOps].sort(),
    ["inspect", "modify", "validate"],
  );
  assert.equal(run.lastSubagentProgress, "child-1:running:2:0");
});

test("resetRunStateAfterSteering clears obligations and preserves timeline", () => {
  const run = createRunState({
    recoveryPlan,
    lastSubagentProgress: "old",
  });
  run.round = 5;
  run.timelineTextLength = 40;
  run.lastPromptTokens = 1200;
  run.lastRuntimeCompactionTokens = 800;
  run.stalledRounds = 3;
  run.semanticStallRounds = 2;
  run.validationStallRounds = 1;
  run.noProgressFingerprints.add("a|b");
  run.budgets.completionRetries = 2;
  run.budgets.autoContinues = 1;
  run.budgets.emptyTurns = 1;
  run.budgets.reasoningOnlyTurns = 1;
  run.budgets.planRecoveryNudges = 2;
  run.requestedGitOps.add("commit");
  run.requestedBrowserOps.add("open");
  run.imageFallbackNoticeSent = true;
  run.repetitionFinalizationPending = "repetition-stalled";
  run.externalWaitStallRounds = 4;
  run.externalWaitStartedAt = 99;
  run.externalWorkAbandoned = true;
  run.prevRound.toolNarrative = "kept";

  resetRunStateAfterSteering(run, "fresh");

  assert.equal(run.round, 5);
  assert.equal(run.timelineTextLength, 40);
  assert.equal(run.lastPromptTokens, 1200);
  assert.equal(run.lastRuntimeCompactionTokens, 800);
  assert.equal(run.imageFallbackNoticeSent, true);
  assert.equal(run.prevRound.toolNarrative, "kept");
  assert.equal(run.stalledRounds, 0);
  assert.equal(run.semanticStallRounds, 0);
  assert.equal(run.validationStallRounds, 0);
  assert.equal(run.noProgressFingerprints.size, 0);
  assert.deepEqual(run.budgets, {
    completionRetries: 0,
    autoContinues: 0,
    emptyTurns: 0,
    reasoningOnlyTurns: 0,
    planRecoveryNudges: 0,
  });
  assert.equal(run.requestedCodingEvidenceOps.size, 0);
  assert.equal(run.requestedGitOps.size, 0);
  assert.equal(run.requestedBrowserOps.size, 0);
  assert.equal(run.repetitionFinalizationPending, undefined);
  assert.equal(run.externalWaitStallRounds, 0);
  assert.equal(run.externalWaitStartedAt, undefined);
  assert.equal(run.externalWorkAbandoned, false);
  assert.equal(run.lastSubagentProgress, "fresh");
  assert.deepEqual(run.plan, {
    steps: [],
    statuses: undefined,
    requirements: [],
    cursor: 0,
    requirementsDeclared: true,
  });
});

test("applyPlanUpdate moves the cursor and records new coding obligations", () => {
  const run = createRunState({ recoveryPlan });
  const applied = applyPlanUpdate(run, {
    plan: [
      {
        step: "inspect login",
        status: "completed",
        requires: ["inspect"],
      },
      {
        step: "fix login",
        status: "completed",
        requires: ["modify", "validate"],
      },
      {
        step: "run tests",
        status: "pending",
        requires: ["execute"],
      },
    ],
  });
  assert.equal(applied.planChanged, true);
  assert.deepEqual(applied.planSteps, [
    "inspect login",
    "fix login",
    "run tests",
  ]);
  assert.equal(applied.planStep, 2);
  assert.equal(run.plan.cursor, 2);
  assert.equal(run.plan.requirementsDeclared, true);
  assert.deepEqual(run.plan.statuses, [
    "completed",
    "completed",
    "pending",
  ]);
  assert.deepEqual(
    [...run.requestedCodingEvidenceOps].sort(),
    ["execute", "inspect", "modify", "validate"],
  );
});

test("applyPlanUpdate prefers in_progress over pending and reports unchanged plans", () => {
  const run = createRunState();
  const first = applyPlanUpdate(run, {
    plan: [
      { step: "one", status: "completed", requires: [] },
      { step: "two", status: "in_progress", requires: ["modify"] },
      { step: "three", status: "pending", requires: [] },
    ],
  });
  assert.equal(first.planChanged, true);
  assert.equal(run.plan.cursor, 1);
  assert.equal(first.planStep, 1);

  const again = applyPlanUpdate(run, {
    plan: [
      { step: "one", status: "completed", requires: [] },
      { step: "two", status: "in_progress", requires: ["modify"] },
      { step: "three", status: "pending", requires: [] },
    ],
  });
  assert.equal(again.planChanged, false);
  assert.equal(run.plan.cursor, 1);
});

test("applyPlanUpdate uses the last step when every step is completed", () => {
  const run = createRunState();
  const applied = applyPlanUpdate(run, {
    plan: [
      { step: "one", status: "completed", requires: [] },
      { step: "two", status: "completed", requires: [] },
    ],
  });
  assert.equal(run.plan.cursor, 1);
  assert.equal(applied.planStep, 1);
  assert.deepEqual(applied.planSteps, ["one", "two"]);
});
