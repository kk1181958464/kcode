import assert from "node:assert/strict";
import test from "node:test";
import { decideRuntimeCompaction } from "./runtime-compaction-policy";

test("reserves output and safety budget before deciding to compact", () => {
  const decision = decideRuntimeCompaction({
    contextWindow: 100_000,
    promptTokens: 90_000,
    lastCompactionTokens: 0,
    systemAndToolTokens: 10_000,
    outputReserveTokens: 10_000,
    safetyMarginTokens: 5_000,
  });
  assert.equal(decision.availableHistoryTokens, 75_000);
  assert.equal(decision.shouldCompact, true);
  assert.equal(decision.forced, true);
});

test("does not compact a prompt below the complete history budget", () => {
  const decision = decideRuntimeCompaction({
    contextWindow: 100_000,
    promptTokens: 50_000,
    lastCompactionTokens: 45_000,
    systemAndToolTokens: 10_000,
    outputReserveTokens: 10_000,
    safetyMarginTokens: 5_000,
  });
  assert.equal(decision.availableHistoryTokens, 75_000);
  assert.equal(decision.shouldCompact, false);
});

test("compacts the first time history crosses the retained budget", () => {
  const decision = decideRuntimeCompaction({
    contextWindow: 100_000,
    promptTokens: 70_000,
    lastCompactionTokens: 0,
    systemAndToolTokens: 10_000,
    outputReserveTokens: 10_000,
    safetyMarginTokens: 5_000,
  });
  assert.equal(decision.availableHistoryTokens, 75_000);
  assert.equal(decision.forced, false);
  assert.equal(decision.shouldCompact, true);
});

test("does not recompact until history grows enough after the last pass", () => {
  const decision = decideRuntimeCompaction({
    contextWindow: 100_000,
    promptTokens: 71_000,
    lastCompactionTokens: 70_000,
    systemAndToolTokens: 10_000,
    outputReserveTokens: 10_000,
    safetyMarginTokens: 5_000,
  });
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.growth, 1_000);
});