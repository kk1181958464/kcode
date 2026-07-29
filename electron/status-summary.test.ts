import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidationActivity,
  latestRequestActivities,
  summarizeStatusActivities,
} from "../src/status-summary";
import type { AgentActivity } from "../src/types";

function activity(
  overrides: Partial<AgentActivity> & Pick<AgentActivity, "id" | "tool">,
): AgentActivity {
  return {
    requestId: "request-2",
    status: "success",
    title: "步骤",
    startedAt: 1,
    input: {},
    ...overrides,
  };
}

test("status summary only selects the latest request", () => {
  const activities = [
    activity({ id: "old", requestId: "request-1", tool: "read_file" }),
    activity({ id: "new", tool: "search_code" }),
  ];
  assert.deepEqual(
    latestRequestActivities(activities).map((item) => item.id),
    ["new"],
  );
  assert.deepEqual(
    latestRequestActivities(activities, "request-1").map((item) => item.id),
    ["old"],
  );
});

test("status summary aggregates successful file changes and command results", () => {
  const activities = [
    activity({
      id: "edit-1",
      tool: "apply_patch",
      path: "src/App.tsx",
      additions: 12,
      deletions: 3,
    }),
    activity({
      id: "edit-2",
      tool: "write_file",
      fileChanges: [
        { path: "src/App.tsx", additions: 2, deletions: 1 },
        { path: "src/styles.css", additions: 8, deletions: 0 },
      ],
    }),
    activity({
      id: "test",
      tool: "run_command",
      command: "npm test",
      status: "failed",
    }),
    activity({ id: "build", tool: "diagnostics", status: "running" }),
  ];

  const summary = summarizeStatusActivities(activities);
  assert.equal(summary.fileChanges.length, 2);
  assert.equal(summary.additions, 22);
  assert.equal(summary.deletions, 4);
  assert.equal(summary.commands, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.active?.id, "build");
  assert.deepEqual(
    summary.validations.map((item) => item.id),
    ["test", "build"],
  );
  assert.equal(isValidationActivity(activities[0]), false);
});
