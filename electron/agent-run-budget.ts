import type { AgentRole } from "../src/types";

export const EXECUTOR_SOFT_ROUND_LIMIT = 24;
export const EXECUTOR_HARD_ROUND_LIMIT = 48;
export const EXECUTOR_SOFT_DURATION_MS = 15 * 60_000;
export const EXECUTOR_HARD_DURATION_MS = 30 * 60_000;

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
  if (agentRole !== "executor" || hasPendingInstructions) return undefined;
  if (
    completedRounds >= EXECUTOR_HARD_ROUND_LIMIT ||
    elapsedMs >= EXECUTOR_HARD_DURATION_MS
  )
    return "limit-reached";
  if (
    evidenceComplete &&
    (completedRounds >= EXECUTOR_SOFT_ROUND_LIMIT ||
      elapsedMs >= EXECUTOR_SOFT_DURATION_MS)
  )
    return "evidence-complete";
  return undefined;
}
