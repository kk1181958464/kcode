import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "../src/types";
import { executorModelOverrides, isPlannerCoordinator } from "./collaboration";
import { modelRequestSchema } from "./ipc-validation";

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
