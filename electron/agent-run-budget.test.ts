import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_HARD_DURATION_MS,
  EXECUTOR_HARD_ROUND_LIMIT,
  EXECUTOR_SOFT_DURATION_MS,
  EXECUTOR_SOFT_ROUND_LIMIT,
  SUBAGENT_HARD_ROUND_LIMIT,
  SUBAGENT_SOFT_ROUND_LIMIT,
  PLANNER_HARD_ROUND_LIMIT,
  PLANNER_SOFT_ROUND_LIMIT,
  ROOT_HARD_DURATION_MS,
  ROOT_HARD_ROUND_LIMIT,
  ROOT_SOFT_DURATION_MS,
  ROOT_SOFT_ROUND_LIMIT,
  agentFinalizationMode,
  externalWaitLimitReached,
} from "./agent-run-budget";

test("bounds ordinary runs with an explicit root-task budget", () => {
  assert.equal(
    agentFinalizationMode({
      agentRole: undefined,
      completedRounds: ROOT_SOFT_ROUND_LIMIT - 1,
      elapsedMs: ROOT_SOFT_DURATION_MS - 1,
      evidenceComplete: true,
    }),
    undefined,
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: undefined,
      completedRounds: ROOT_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: undefined,
      completedRounds: ROOT_HARD_ROUND_LIMIT,
      elapsedMs: ROOT_HARD_DURATION_MS,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
});

test("finalizes a planner coordinator on its own budget", () => {
  // The planner only inspects and delegates, so it gets a tighter budget than
  // the executor and must still finalize instead of spinning in read-only loops.
  assert.equal(
    agentFinalizationMode({
      agentRole: "planner",
      completedRounds: PLANNER_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: "planner",
      completedRounds: PLANNER_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
  // Below the soft limit with incomplete evidence, the planner keeps going.
  assert.equal(
    agentFinalizationMode({
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
    agentFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    agentFinalizationMode({
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
    agentFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_SOFT_ROUND_LIMIT,
      elapsedMs: EXECUTOR_SOFT_DURATION_MS,
      evidenceComplete: false,
    }),
    undefined,
  );
  assert.equal(
    agentFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
});

test("gives ordinary subagents a bounded independent budget", () => {
  assert.equal(
    agentFinalizationMode({
      agentDepth: 1,
      completedRounds: SUBAGENT_SOFT_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: true,
    }),
    "evidence-complete",
  );
  assert.equal(
    agentFinalizationMode({
      agentDepth: 1,
      completedRounds: SUBAGENT_HARD_ROUND_LIMIT,
      elapsedMs: 1,
      evidenceComplete: false,
    }),
    "limit-reached",
  );
});

test("detects a child wait that has exceeded its no-progress guard", () => {
  assert.equal(
    externalWaitLimitReached({ stalledRounds: 3, startedAt: 100, now: 100 }),
    false,
  );
  assert.equal(
    externalWaitLimitReached({ stalledRounds: 4, startedAt: 100, now: 100 }),
    true,
  );
  assert.equal(
    externalWaitLimitReached({
      stalledRounds: 0,
      startedAt: 100,
      now: 300_100,
    }),
    true,
  );
});

test("defers finalization for a newly queued parent instruction", () => {
  assert.equal(
    agentFinalizationMode({
      agentRole: "executor",
      completedRounds: EXECUTOR_HARD_ROUND_LIMIT,
      elapsedMs: EXECUTOR_HARD_DURATION_MS,
      evidenceComplete: true,
      hasPendingInstructions: true,
    }),
    undefined,
  );
});
