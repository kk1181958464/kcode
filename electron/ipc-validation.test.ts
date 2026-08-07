import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "../src/types";
import { executorModelOverrides, isPlannerCoordinator } from "./collaboration";
import {
  modelRequestSchema,
  sshRemoteExpectedContentSchema,
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
});

test("distinguishes a new SSH Remote file from an unchecked overwrite", () => {
  assert.equal(sshRemoteExpectedContentSchema.parse(null), null);
  assert.equal(sshRemoteExpectedContentSchema.parse(undefined), undefined);
  assert.equal(
    sshRemoteExpectedContentSchema.parse("old content"),
    "old content",
  );
});
