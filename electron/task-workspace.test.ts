import assert from "node:assert/strict";
import test from "node:test";
import type { TaskRecord } from "../src/models";
import type { SshRemoteProfile } from "../src/ssh-remote-types";
import { attachSshWorkspace, taskWorkspaceName } from "../src/task-workspace";

const profile: SshRemoteProfile = {
  id: "profile-a",
  name: "root@203.0.113.8",
  host: "203.0.113.8",
  port: 22,
  username: "root",
  rootPath: "/root",
  authType: "private-key",
  remembered: true,
};

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-a",
    name: "修复登录页",
    workspacePath: "D:\\project\\注册机",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    activities: [],
    ...overrides,
  };
}

test("attaching SSH preserves the task and local project names", () => {
  const attached = attachSshWorkspace(
    task(),
    { profile, cachePath: "C:\\cache\\profile-a" },
    2,
  );

  assert.equal(attached.name, "修复登录页");
  assert.equal(attached.workspaceName, "注册机");
  assert.equal(attached.workspacePath, "C:\\cache\\profile-a");
  assert.equal(attached.remoteWorkspace, profile);
  assert.equal(attached.updatedAt, 2);
});

test("reconnecting a legacy SSH task does not fall back to its profile name", () => {
  const attached = attachSshWorkspace(
    task({
      name: "侯马政府项目",
      workspacePath: "C:\\cache\\profile-a",
      remoteWorkspace: profile,
    }),
    {
      profile: { ...profile, rootPath: "/srv/new-root" },
      cachePath: "C:\\cache\\new",
    },
    3,
  );

  assert.equal(attached.name, "侯马政府项目");
  assert.equal(attached.workspaceName, "侯马政府项目");
  assert.equal(taskWorkspaceName(attached), "侯马政府项目");
});
