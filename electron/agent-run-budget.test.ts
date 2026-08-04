import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_HARD_DURATION_MS,
  EXECUTOR_HARD_ROUND_LIMIT,
  EXECUTOR_SOFT_DURATION_MS,
  EXECUTOR_SOFT_ROUND_LIMIT,
  executorFinalizationMode,
} from "./agent-run-budget";

test("does not limit ordinary or planner runs", () => {
  for (const agentRole of [undefined, "planner"] as const)
    assert.equal(
      executorFinalizationMode({
        agentRole,
        completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
        elapsedMs: EXECUTOR_HARD_DURATION_MS,
        evidenceComplete: true,
      }),
      undefined,
    );
});

test("finalizes an executor after the soft limit when evidence is complete", () => {
  assert.equal(
    executorFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    executorFinalizationMode({
      agentRole: "executor",
      completedRounds: 1,
      elapsedMs: EXECUTOR_SOFT_DURATION_MS,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
});

test("allows incomplete work until the executor hard limit", () => {
  assert.equal(
    executorFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_SOFT_ROUND_LIMIT,
      elapsedMs: EXECUTOR_SOFT_DURATION_MS,
      evidenceComplete: false,
    }),
    undefined,
  );
  assert.equal(
    executorFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
});

test("defers finalization for a newly queued parent instruction", () => {
  assert.equal(
    executorFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: EXECUTOR_HARD_DURATION_MS,
      evidenceComplete: true,
      hasPendingInstructions: true,
    }),
    undefined,
  );
});
