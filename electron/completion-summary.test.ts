import assert from "node:assert/strict";
import test from "node:test";
import {
  completionResultFromActivities,
  pausedCompletionNarrative,
} from "../src/completion-summary";
import type { AgentActivity } from "../src/types";

function activity(
  overrides: Partial<AgentActivity> & Pick<AgentActivity, "tool" | "status">,
): AgentActivity {
  return {
    id: crypto.randomUUID(),
    requestId: "request-1",
    title: overrides.tool,
    startedAt: 1,
    input: {},
    ...overrides,
  };
}

test("pause summaries expose actual files and execution counts", () => {
  const result = completionResultFromActivities([
    activity({
      tool: "write_file",
      status: "success",
      path: "src/App.tsx",
      fileChanges: [{ path: "src/App.tsx", additions: 12, deletions: 4 }],
      operationEvidence: ["modify"],
    }),
    activity({
      tool: "ssh_run",
      status: "failed",
      command: "npm run build",
      errorSummary: "命令失败",
    }),
  ]);

  assert.equal(result.kind, "incomplete");
  assert.equal(result.toolCalls, 2);
  assert.equal(result.successfulTools, 1);
  assert.equal(result.failedTools, 1);
  assert.deepEqual(result.changedFiles, ["src/App.tsx"]);
  assert.equal(result.additions, 12);
  assert.equal(result.deletions, 4);

  const narrative = pausedCompletionNarrative(result);
  assert.match(narrative, /src\/App\.tsx/);
  assert.match(narrative, /\+12 -4/);
  assert.match(narrative, /失败/);
});
