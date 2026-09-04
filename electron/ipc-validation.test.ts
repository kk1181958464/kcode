import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "../src/types";
import { executorModelOverrides, isPlannerCoordinator } from "./collaboration";
import {
  modelRequestSchema,
  saveTaskOptionsSchema,
  sshRemoteExpectedContentSchema,
  taskItemPageOptionsSchema,
  taskRequestIdsSchema,
} from "./ipc-validation";

test("preserves planner-executor routing through IPC validation", () => {
  const parsed = modelRequestSchema.parse({
    requestId: "request-1",
    taskId: "task-1",
    providerId: "kaka",
    modelId: "gpt-5.6-sol",
    messages: [{ role: "user", content: "实现功能" }],
    reasoningEffort: "medium",
    permissionMode: "full-access",
    workspacePath: "D:\\project\\demo",
    contextWindow: 353_400,
    agentRole: "planner",
    collaboration: {
      mode: "planner-executor",
      executor: {
        providerId: "kaka",
        modelId: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        reasoningEffort: "high",
        contextWindow: 353_400,
      },
    },
  }) as ModelRequest;

  assert.equal(isPlannerCoordinator(parsed), true);
  assert.deepEqual(executorModelOverrides(parsed), {
    providerId: "kaka",
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    reasoningEffort: "high",
    contextWindow: 353_400,
    agentRole: "executor",
    collaboration: undefined,
  });
});

test("rejects an unsupported executor reasoning effort", () => {
  const result = modelRequestSchema.safeParse({
    providerId: "kaka",
    modelId: "gpt-5.6-sol",
    messages: [],
    permissionMode: "full-access",
    workspacePath: "D:\\project\\demo",
    agentRole: "planner",
    collaboration: {
      mode: "planner-executor",
      executor: {
        providerId: "kaka",
        modelId: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        reasoningEffort: "unlimited",
      },
    },
  });

  assert.equal(result.success, false);
});

test("preserves SSH Remote routing metadata through IPC validation", () => {
  const parsed = modelRequestSchema.parse({
    requestId: "request-remote",
    taskId: "task-remote",
    connectionSessionId: "task-remote",
    providerId: "kaka",
    modelId: "gpt-5.6-sol",
    messages: [{ role: "user", content: "检查远程项目" }],
    permissionMode: "full-access",
    workspacePath:
      "C:\\Users\\test\\AppData\\Local\\KCode\\ssh-workspaces\\profile",
    localWorkspacePath: "D:\\projects\\payment",
    remoteWorkspace: {
      id: "profile-1",
      name: "生产服务器",
      host: "203.0.113.8",
      port: 22,
      username: "deploy",
      rootPath: "/srv/app",
      authType: "private-key",
      remembered: true,
    },
  }) as ModelRequest;

  assert.equal(parsed.connectionSessionId, "task-remote");
  assert.equal(parsed.remoteWorkspace?.rootPath, "/srv/app");
  assert.equal(parsed.remoteWorkspace?.host, "203.0.113.8");
  assert.equal(parsed.localWorkspacePath, "D:\\projects\\payment");
});

test("distinguishes a new SSH Remote file from an unchecked overwrite", () => {
  assert.equal(sshRemoteExpectedContentSchema.parse(null), null);
  assert.equal(sshRemoteExpectedContentSchema.parse(undefined), undefined);
  assert.equal(
    sshRemoteExpectedContentSchema.parse("old content"),
    "old content",
  );
});

test("validates bounded task item paging", () => {
  assert.deepEqual(taskItemPageOptionsSchema.parse({ limit: 80 }), {
    limit: 80,
  });
  assert.deepEqual(
    taskItemPageOptionsSchema.parse({ before: "message-20", limit: 50 }),
    { before: "message-20", limit: 50 },
  );
  assert.equal(
    taskItemPageOptionsSchema.safeParse({ before: "a", after: "b" }).success,
    false,
  );
  assert.equal(
    taskItemPageOptionsSchema.safeParse({ limit: 201 }).success,
    false,
  );
});

test("validates partial task save options", () => {
  assert.deepEqual(saveTaskOptionsSchema.parse({}), {});
  assert.deepEqual(
    saveTaskOptionsSchema.parse({ preserveUnloadedItems: true }),
    { preserveUnloadedItems: true },
  );
  assert.equal(
    saveTaskOptionsSchema.safeParse({ preserveUnloadedItems: "yes" }).success,
    false,
  );
});

test("bounds activity request lookups", () => {
  assert.deepEqual(taskRequestIdsSchema.parse(["r1", "r2"]), ["r1", "r2"]);
  assert.equal(
    taskRequestIdsSchema.safeParse(
      Array.from({ length: 101 }, (_, i) => `r${i}`),
    ).success,
    false,
  );
});
