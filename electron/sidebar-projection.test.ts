import assert from "node:assert/strict";
import test from "node:test";
import { initialTask } from "../src/models";
import {
  projectSidebarWorkspaceGroups,
  sidebarTaskRenderKey,
  sidebarWorkspaceKey,
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
  assert.equal(next.workspaceGroups[0].runningCount, 1);
});

test("aggregates running conversations on their workspace row", () => {
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "运行中的对话", "D:\\project\\alpha"),
        runningId: "request-a",
        runStatus: "running",
      },
      task("task-b", "空闲对话", "D:\\project\\alpha"),
      {
        ...task("task-c", "恢复中的对话", "D:\\project\\alpha"),
        runStatus: "running",
      },
    ],
    "",
    false,
  );

  assert.equal(projection.workspaceGroups[0].runningCount, 2);
});

test("keeps the virtual row key stable across runtime status changes", () => {
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

  assert.equal(sidebarTaskRenderKey(firstRun), sidebarTaskRenderKey(finished));
  assert.equal(sidebarTaskRenderKey(finished), sidebarTaskRenderKey(secondRun));
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

test("groups SSH Remote tasks by profile without replacing the project name", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "生产服务器",
    host: "203.0.113.8",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app",
    authType: "private-key" as const,
    remembered: true,
  };
  const tasks = [
    {
      ...task("task-a", "部署", "C:\\cache\\profile-a"),
      workspaceName: "支付系统",
      remoteWorkspace,
    },
    {
      ...task("task-b", "检查日志", "C:\\cache\\profile-a"),
      workspaceName: "支付系统",
      remoteWorkspace,
    },
  ];
  const projection = projectSidebarWorkspaceGroups(tasks, "", false);

  assert.equal(projection.workspaceGroups.length, 1);
  assert.equal(projection.workspaceGroups[0].name, "支付系统");
  assert.equal(projection.workspaceGroups[0].remote, true);
  assert.equal(projection.workspaceGroups[0].conversations.length, 2);
});

test("exposes a shared local project path for an SSH workspace", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "生产服务器",
    host: "203.0.113.8",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app",
    authType: "private-key" as const,
    remembered: true,
  };
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "部署", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        localWorkspacePath: "D:\\projects\\payment",
        remoteWorkspace,
      },
      {
        ...task("task-b", "检查", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        localWorkspacePath: "D:\\projects\\payment",
        remoteWorkspace,
      },
    ],
    "",
    false,
  );

  assert.equal(
    projection.workspaceGroups[0].localWorkspacePath,
    "D:\\projects\\payment",
  );
});

test("does not expose an ambiguous local project path for mixed SSH tasks", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "生产服务器",
    host: "203.0.113.8",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app",
    authType: "private-key" as const,
    remembered: true,
  };
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "部署", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        localWorkspacePath: "D:\\projects\\payment",
        remoteWorkspace,
      },
      {
        ...task("task-b", "检查", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        localWorkspacePath: "D:\\projects\\other",
        remoteWorkspace,
      },
    ],
    "",
    false,
  );

  assert.equal(projection.workspaceGroups[0].localWorkspacePath, undefined);
});

test("does not expose a group project path when one task has no local project", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "生产服务器",
    host: "203.0.113.8",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app",
    authType: "private-key" as const,
    remembered: true,
  };
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "部署", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        localWorkspacePath: "D:\\projects\\payment",
        remoteWorkspace,
      },
      {
        ...task("task-b", "检查", "C:\\cache\\profile-a"),
        workspaceName: "支付系统",
        remoteWorkspace,
      },
    ],
    "",
    false,
  );

  assert.equal(projection.workspaceGroups[0].localWorkspacePath, undefined);
});

test("keeps different project roots on one SSH profile in separate groups", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "生产服务器",
    host: "203.0.113.8",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app-a",
    authType: "private-key" as const,
    remembered: true,
  };
  const tasks = [
    {
      ...task("task-a", "项目 A", "C:\\cache\\profile-a"),
      workspaceName: "项目 A",
      remoteWorkspace,
    },
    {
      ...task("task-b", "项目 B", "C:\\cache\\profile-a"),
      workspaceName: "项目 B",
      remoteWorkspace: { ...remoteWorkspace, rootPath: "/srv/app-b" },
    },
  ];
  const projection = projectSidebarWorkspaceGroups(tasks, "", false);

  assert.equal(projection.workspaceGroups.length, 2);
  assert.notEqual(
    projection.workspaceGroups[0].key,
    projection.workspaceGroups[1].key,
  );
  assert.deepEqual(
    projection.workspaceGroups.map((group) => group.name),
    ["项目 A", "项目 B"],
  );
});

test("does not absorb a newly adopted task into another named SSH project", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "root@203.0.113.8",
    host: "203.0.113.8",
    port: 22,
    username: "root",
    rootPath: "/srv/shared",
    authType: "private-key" as const,
    remembered: true,
  };
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "旧任务", "C:\\cache\\profile-a"),
        workspaceName: "已有项目",
        remoteWorkspace,
      },
      {
        ...task("task-b", "快乐森林", "C:\\cache\\profile-a"),
        workspaceName: "快乐森林",
        remoteWorkspace,
      },
    ],
    "",
    false,
  );

  assert.equal(projection.workspaceGroups.length, 2);
  assert.deepEqual(
    projection.workspaceGroups.map((group) => group.name),
    ["已有项目", "快乐森林"],
  );
});

test("recovers a legacy SSH workspace label from its task name", () => {
  const remoteWorkspace = {
    id: "profile-a",
    name: "root@203.0.113.8",
    host: "203.0.113.8",
    port: 22,
    username: "root",
    rootPath: "/root",
    authType: "private-key" as const,
    remembered: true,
  };
  const projection = projectSidebarWorkspaceGroups(
    [
      {
        ...task("task-a", "注册机", "C:\\cache\\profile-a"),
        remoteWorkspace,
      },
    ],
    "",
    false,
  );

  assert.equal(projection.workspaceGroups[0].name, "注册机");
  assert.equal(
    sidebarWorkspaceKey(projection.workspaceGroups[0].conversations[0]),
    sidebarWorkspaceKey({
      ...task("task-b", "新对话", "C:\\cache\\profile-a"),
      workspaceName: "注册机",
      remoteWorkspace,
    }),
  );
});
