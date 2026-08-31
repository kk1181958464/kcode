export const STALL_RECOVERY_ROUNDS = 2;
export const STALL_FINALIZATION_ROUNDS = 5;
// A changing read-only output (timestamps, process ids, log offsets, etc.) is
// not sufficient evidence of progress. Bound those rounds separately from the
// exact-fingerprint guard so verification cannot spin forever.
export const SEMANTIC_STALL_ROUNDS = 10;

export type StallAction = "continue" | "recover" | "finalize";

export function stallAction(stalledRounds: number): StallAction {
  // Fingerprints include tool input, status, output, and diff. Reaching this
  // policy therefore means the runtime observed the same result, not merely
  // another legitimate read-only check.
  if (stalledRounds >= STALL_FINALIZATION_ROUNDS) return "finalize";
  if (stalledRounds === STALL_RECOVERY_ROUNDS) return "recover";
  return "continue";
}
