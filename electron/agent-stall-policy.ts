export const STALL_RECOVERY_ROUNDS = 3;
export const STALL_PAUSE_ROUNDS = 5;

export type StallAction = "continue" | "recover" | "pause";

export function stallAction(stalledRounds: number): StallAction {
  if (stalledRounds >= STALL_PAUSE_ROUNDS) return "pause";
  if (stalledRounds === STALL_RECOVERY_ROUNDS) return "recover";
  return "continue";
}
