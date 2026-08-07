import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelAttemptBudget,
  ModelAttemptBudgetExhaustedError,
} from "./model-attempt-budget";

test("shares a fixed attempt count across callers", () => {
  const budget = new ModelAttemptBudget(3);
  assert.equal(budget.acquire(), 1);
  assert.equal(budget.acquire(), 2);
  assert.equal(budget.remaining, 1);
  assert.equal(budget.acquire(), 3);
  assert.equal(budget.canAttempt(), false);
  assert.throws(() => budget.acquire(), ModelAttemptBudgetExhaustedError);
});
