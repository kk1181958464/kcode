import type { AgentRole } from "../src/types";

export const EXECUTOR_SOFT_ROUND_LIMIT = 24;
export const EXECUTOR_HARD_ROUND_LIMIT = 48;
export const EXECUTOR_SOFT_DURATION_MS = 15 * 60_000;
export const EXECUTOR_HARD_DURATION_MS = 30 * 60_000;

// The planner coordinator only inspects (read-only) and delegates via
// spawn_agent/wait_agent; the heavy work runs inside the executor, which has
// its own budget. Bound the planner so it cannot spin in read-only inspection
// forever, burning tokens without ever finalizing.
export const PLANNER_SOFT_ROUND_LIMIT = 18;
export const PLANNER_HARD_ROUND_LIMIT = 36;
export const PLANNER_SOFT_DURATION_MS = 12 * 60_000;
export const PLANNER_HARD_DURATION_MS = 24 * 60_000;

export type ExecutorFinalizationMode = "evidence-complete" | "limit-reached";

export function executorFinalizationMode({
  agentRole,
  completedRounds,
  elapsedMs,
  evidenceComplete,
  hasPendingInstructions = false,
}: {
  agentRole?: AgentRole;
  completedRounds: number;
  elapsedMs: number;
  evidenceComplete: boolean;
  hasPendingInstructions?: boolean;
}): ExecutorFinalizationMode | undefined {
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
        : undefined;
  if (!limits) return undefined;
  if (
    completedRounds >= limits.hardRounds ||
    elapsedMs >= limits.hardMs
  )
    return "limit-reached";
  if (
    evidenceComplete &&
    (completedRounds >= limits.softRounds || elapsedMs >= limits.softMs)
  )
    return "evidence-complete";
  return undefined;
}
