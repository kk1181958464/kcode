import assert from "node:assert/strict";
import test from "node:test";
import { normalizeActivity, summarizeActivities } from "../src/activity-view-model";
import type { AgentActivity } from "../src/types";

function activity(
  patch: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id: "activity-1",
    requestId: "request-1",
    tool: "run_command",
    status: "running",
    title: "运行检查",
    startedAt: 1,
    input: { command: "npm test" },
    command: "npm test",
    ...patch,
  };
}

test("normalizes execution model and user-facing state in one place", () => {
  const view = normalizeActivity(
    activity({
      status: "failed",
      recoverable: true,
      agentRole: "executor",
      modelDisplayName: "GPT-5.6 Luna",
      reasoningEffort: "high",
    }),
  );
  assert.equal(view.kind, "command");
  assert.equal(view.statusLabel, "访问受限");
  assert.equal(view.target, "npm test");
  assert.equal(view.model, "GPT-5.6 Luna");
  assert.equal(view.reasoningEffort, "high");
  assert.equal(view.failed, true);
  assert.equal(view.recoverable, true);
});

test("summarizes live and completed activities without counting recovery as failure", () => {
  const summary = summarizeActivities([
    activity({ id: "command", status: "success" }),
    activity({ id: "agent", tool: "spawn_agent", status: "success" }),
    activity({ id: "limited", status: "failed", recoverable: true }),
    activity({ id: "live", status: "waiting" }),
  ]);
  assert.deepEqual(
    {
      commands: summary.commands,
      agents: summary.agents,
      completed: summary.completed,
      failures: summary.failures,
      limited: summary.limited,
      waiting: summary.waiting,
      active: summary.active?.id,
    },
    {
      commands: 3,
      agents: 1,
      completed: 2,
      failures: 0,
      limited: 1,
      waiting: true,
      active: "live",
    },
  );
});
