export const STALL_RECOVERY_ROUNDS = 3;

export type StallAction = "continue" | "recover";

export function stallAction(stalledRounds: number): StallAction {
  // Repetition is a recovery hint, not a terminal state. A model may perform
  // several legitimate read-only checks after its last mutation, so only an
  // explicit turn end, interruption, run budget, or real error may stop it.
  return stalledRounds >= STALL_RECOVERY_ROUNDS &&
    stalledRounds % STALL_RECOVERY_ROUNDS === 0
    ? "recover"
    : "continue";
}
