import assert from "node:assert/strict";
import test from "node:test";
import { initialTask } from "../src/models";
import {
  projectSidebarWorkspaceGroups,
  sidebarTaskRenderKey,
} from "../src/sidebar-projection";

function task(id: string, name: string, workspacePath: string) {
  return {
    ...initialTask(),
    id,
    name,
    workspacePath,
  };
}

test("keeps the sidebar projection stable for message and activity changes", () => {
  const firstTask = task("task-a", "对话 A", "D:\\project\\alpha");
  const first = projectSidebarWorkspaceGroups([firstTask], "", false);
  const next = projectSidebarWorkspaceGroups(
    [
      {
        ...firstTask,
        messages: [{ id: "message-a", role: "assistant", content: "new" }],
        activities: [
          {
            id: "activity-a",
            type: "command",
            title: "运行命令",
            status: "running",
          },
        ],
        usage: { input: 100, output: 20, cached: 0 },
      },
    ],
    "",
    false,
    first,
  );

  assert.equal(next, first);
  assert.equal(next.workspaceGroups, first.workspaceGroups);
});

test("publishes a new projection for sidebar-visible status changes", () => {
  const firstTask = task("task-a", "对话 A", "D:\\project\\alpha");
  const first = projectSidebarWorkspaceGroups([firstTask], "", false);
  const next = projectSidebarWorkspaceGroups(
    [{ ...firstTask, runningId: "request-a", runStatus: "running" }],
    "",
    false,
    first,
  );

  assert.notEqual(next, first);
  assert.equal(next.workspaceGroups[0].conversations[0].runStatus, "running");
});

test("changes the virtual row key when a queued request replaces the prior run", () => {
  const base = task("task-a", "对话 A", "D:\\project\\alpha");
  const firstRun = {
    ...base,
    runningId: "request-1",
    runStatus: "running" as const,
  };
  const finished = {
    ...base,
    runningId: undefined,
    runStatus: "completed" as const,
  };
  const secondRun = {
    ...base,
    runningId: "request-2",
    runStatus: "running" as const,
  };

  assert.notEqual(
    sidebarTaskRenderKey(firstRun),
    sidebarTaskRenderKey(finished),
  );
  assert.notEqual(
    sidebarTaskRenderKey(finished),
    sidebarTaskRenderKey(secondRun),
  );
});

test("filters cached sidebar metadata without rebuilding task records", () => {
  const tasks = [
    task("task-a", "数据库检查", "D:\\project\\alpha"),
    task("task-b", "界面优化", "D:\\project\\alpha"),
  ];
  const first = projectSidebarWorkspaceGroups(tasks, "", false);
  const filtered = projectSidebarWorkspaceGroups(tasks, "界面", false, first);

  assert.equal(filtered.snapshot, first.snapshot);
  assert.deepEqual(
    filtered.workspaceGroups[0].conversations.map((item) => item.id),
    ["task-b"],
  );
});
