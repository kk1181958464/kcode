import assert from "node:assert/strict";
import test from "node:test";
import {
  STALL_FINALIZATION_ROUNDS,
  STALL_RECOVERY_ROUNDS,
  stallAction,
} from "./agent-stall-policy";

test("recovers once and then finalizes a repeated tool loop", () => {
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS - 1), "continue");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS), "recover");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS + 1), "continue");
  assert.equal(stallAction(STALL_FINALIZATION_ROUNDS - 1), "continue");
  assert.equal(stallAction(STALL_FINALIZATION_ROUNDS), "finalize");
  assert.equal(stallAction(STALL_FINALIZATION_ROUNDS + 20), "finalize");
});
