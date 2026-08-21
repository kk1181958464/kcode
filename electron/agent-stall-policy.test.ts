import assert from "node:assert/strict";
import test from "node:test";
import { STALL_RECOVERY_ROUNDS, stallAction } from "./agent-stall-policy";

test("uses repeated rounds only as a recurring recovery signal", () => {
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS - 1), "continue");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS), "recover");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS + 1), "continue");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS * 2 - 1), "continue");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS * 2), "recover");
  assert.equal(stallAction(STALL_RECOVERY_ROUNDS * 10), "recover");
});
