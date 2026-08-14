import assert from "node:assert/strict";
import test from "node:test";
import {
  STALL_PAUSE_ROUNDS,
  STALL_RECOVERY_ROUNDS,
  stallAction,
} from "./agent-stall-policy";

test("warns before pausing a repeatedly stalled agent", () => {
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS - 1), "continue");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS), "recover");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS + 1), "continue");
  assert.equal(stallAction(STALL_PAUSE_ROUNDS), "pause");
  assert.equal(stallAction(STALL_PAUSE_ROUNDS + 1), "pause");
});
