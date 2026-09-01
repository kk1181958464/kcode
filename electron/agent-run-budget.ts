import type { AgentRole } from "../src/types";

// Root tasks have a generous guardrail because they may legitimately perform
// long deployments or migrations. This is an explicit run budget; it does not
// infer completion from assistant prose, file counts, or repeated commands.
export const ROOT_SOFT_ROUND_LIMIT = 160;
export const ROOT_HARD_ROUND_LIMIT = 320;
export const ROOT_SOFT_DURATION_MS = 30 * 60_000;
export const ROOT_HARD_DURATION_MS = 60 * 60_000;

export const EXECUTOR_SOFT_ROUND_LIMIT = 24;
export const EXECUTOR_HARD_ROUND_LIMIT = 48;
export const EXECUTOR_SOFT_DURATION_MS = 15 * 60_000;
export const EXECUTOR_HARD_DURATION_MS = 30 * 60_000;

// A regular background subagent is usually a focused inspection or research
// task. It must not inherit the root task's much larger budget, otherwise a
// stalled child can keep its parent waiting for tens of minutes.
export const SUBAGENT_SOFT_ROUND_LIMIT = 10;
export const SUBAGENT_HARD_ROUND_LIMIT = 20;
export const SUBAGENT_SOFT_DURATION_MS = 6 * 60_000;
export const SUBAGENT_HARD_DURATION_MS = 12 * 60_000;

// wait_agent is intentionally sliced so the parent loop can observe child
// progress and apply its no-progress guard instead of blocking in one call.
export const SUBAGENT_WAIT_MIN_MS = 5_000;
export const SUBAGENT_WAIT_SLICE_MS = 60_000;
export const EXTERNAL_WAIT_STALL_ROUNDS = 4;
export const EXTERNAL_WAIT_MAX_DURATION_MS = 5 * 60_000;

export function externalWaitLimitReached({
  stalledRounds,
  startedAt,
  now = Date.now(),
}: {
  stalledRounds: number;
  startedAt?: number;
  now?: number;
}) {
  return (
    stalledRounds >= EXTERNAL_WAIT_STALL_ROUNDS ||
    (startedAt !== undefined &&
      now - startedAt >= EXTERNAL_WAIT_MAX_DURATION_MS)
  );
}

// The planner coordinator only inspects (read-only) and delegates via
// spawn_agent/wait_agent; the heavy work runs inside the executor, which has
// its own budget. Bound the planner so it cannot spin in read-only inspection
// forever, burning tokens without ever finalizing.
export const PLANNER_SOFT_ROUND_LIMIT = 18;
export const PLANNER_HARD_ROUND_LIMIT = 36;
export const PLANNER_SOFT_DURATION_MS = 12 * 60_000;
export const PLANNER_HARD_DURATION_MS = 24 * 60_000;

export type AgentFinalizationMode =
  "evidence-complete" | "limit-reached" | "repetition-stalled";

export function agentFinalizationMode({
  agentRole,
  agentDepth = 0,
  completedRounds,
  elapsedMs,
  evidenceComplete,
  hasPendingInstructions = false,
}: {
  agentRole?: AgentRole;
  agentDepth?: number;
  completedRounds: number;
  elapsedMs: number;
  evidenceComplete: boolean;
  hasPendingInstructions?: boolean;
}): AgentFinalizationMode | undefined {
  if (hasPendingInstructions) return undefined;
  const limits =
    agentRole === "executor"
      ? {
          softRounds: EXECUTOR_SOFT_ROUND_LIMIT,
          hardRounds: EXECUTOR_HARD_ROUND_LIMIT,
          softMs: EXECUTOR_SOFT_DURATION_MS,
          hardMs: EXECUTOR_HARD_DURATION_MS,
        }
      : agentRole === "planner"
        ? {
            softRounds: PLANNER_SOFT_ROUND_LIMIT,
            hardRounds: PLANNER_HARD_ROUND_LIMIT,
            softMs: PLANNER_SOFT_DURATION_MS,
            hardMs: PLANNER_HARD_DURATION_MS,
          }
        : agentDepth > 0
          ? {
              softRounds: SUBAGENT_SOFT_ROUND_LIMIT,
              hardRounds: SUBAGENT_HARD_ROUND_LIMIT,
              softMs: SUBAGENT_SOFT_DURATION_MS,
              hardMs: SUBAGENT_HARD_DURATION_MS,
            }
          : {
              softRounds: ROOT_SOFT_ROUND_LIMIT,
              hardRounds: ROOT_HARD_ROUND_LIMIT,
              softMs: ROOT_SOFT_DURATION_MS,
              hardMs: ROOT_HARD_DURATION_MS,
            };
  if (completedRounds >= limits.hardRounds || elapsedMs >= limits.hardMs)
    return "limit-reached";
  if (
    evidenceComplete &&
    (completedRounds >= limits.softRounds || elapsedMs >= limits.softMs)
  )
    return "evidence-complete";
  return undefined;
}
