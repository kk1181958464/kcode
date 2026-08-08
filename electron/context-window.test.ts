import assert from "node:assert/strict";
import test from "node:test";
import {
  contextPercent,
  contextUsageTokens,
  markContextCompacted,
  observeContextWindow,
} from "../src/context-window";

test("prefers the latest upstream prompt usage over estimates", () => {
  const state = observeContextWindow(undefined, {
    taskId: "task-1",
    limit: 100,
    observedTokens: 81,
    estimatedTokens: 96,
    source: "reported",
  });
  assert.equal(contextUsageTokens(state, 0), 81);
  assert.equal(contextPercent(contextUsageTokens(state, 0), state.limit), 81);
});

test("compaction creates a new explicit context window", () => {
  const first = markContextCompacted(undefined, "task-1", 20, 100);
  const second = markContextCompacted(first, "task-1", 30, 100);
  assert.notEqual(first.windowId, second.windowId);
  assert.equal(second.compactionCount, 2);
  assert.equal(second.lastCompactedAt !== undefined, true);
});
