import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_HARD_DURATION_MS,
  EXECUTOR_HARD_ROUND_LIMIT,
  EXECUTOR_SOFT_DURATION_MS,
  EXECUTOR_SOFT_ROUND_LIMIT,
  PLANNER_HARD_ROUND_LIMIT,
  PLANNER_SOFT_ROUND_LIMIT,
  executorFinalizationMode,
} from "./agent-run-budget";

test("does not limit ordinary runs", () => {
  assert.equal(
    executorFinalizationMode({
      agentRole: undefined,
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: EXECUTOR_HARD_DURATION_MS,
      evidenceComplete: true,
    }),
    undefined,
  );
});

test("finalizes a planner coordinator on its own budget", () => {
  // The planner only inspects and delegates, so it gets a tighter budget than
  // the executor and must still finalize instead of spinning in read-only loops.
  assert.equal(
    executorFinalizationMode({
      agentRole: "planner",
      completedRounds: PLANNER_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    executorFinalizationMode({
      agentRole: "planner",
      completedRounds: PLANNER_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
  // Below the soft limit with incomplete evidence, the planner keeps going.
  assert.equal(
    executorFinalizationMode({
      agentRole: "planner",
      completedRounds: 1,
      elapsedMs: 1,
      evidenceComplete: false,
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
