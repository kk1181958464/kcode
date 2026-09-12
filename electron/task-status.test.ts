import test from "node:test";
import assert from "node:assert/strict";
import {
  finishTaskRequest,
  isRetryableDisconnectError,
  isTaskViewCurrent,
  nextQueuedMessageId,
  recoverOrphanedFailure,
  recoverInterruptedActivities,
  recoverRetryableDisconnectMessages,
  recoverTaskRunStatus,
} from "../src/task-status";
import type { AgentActivity, ChatMessage } from "../src/types";

const message = (content: string): ChatMessage => ({
  id: content,
  role: "assistant",
  content,
  createdAt: 1,
});

test("recovers persisted running tasks as paused", () => {
  assert.equal(
    recoverTaskRunStatus({
      runStatus: "running",
      messages: [],
    }),
    "paused",
  );
  assert.equal(
    recoverTaskRunStatus({
      runningId: "request-1",
      messages: [message("partial output")],
    }),
    "paused",
  );
});

test("recovers failure only from structured message errors", () => {
  assert.equal(
    recoverTaskRunStatus({
      messages: [
        message("earlier result"),
        { ...message("partial output"), error: "invalid api key" },
      ],
    }),
    "failed",
  );
  assert.equal(
    recoverTaskRunStatus({
      messages: [message("请求失败：这是被引用的普通文字")],
    }),
    "completed",
  );
});

test("launch failures stay failed even when the detail looks retryable", () => {
  assert.equal(
    isRetryableDisconnectError(
      "生成失败：模型请求未能启动。网络连接异常，请检查网络后重试。",
    ),
    false,
  );
  assert.equal(
    recoverTaskRunStatus({
      messages: [
        {
          ...message(""),
          error:
            "生成失败：模型请求未能启动。网络连接异常，请检查网络后重试。",
        },
      ],
    }),
    "failed",
  );
});

test("recovers retryable disconnect errors as paused", () => {
  assert.equal(
    recoverTaskRunStatus({
      messages: [
        message("earlier result"),
        { ...message("partial output"), error: "upstream 502" },
      ],
    }),
    "paused",
  );
  assert.equal(
    recoverTaskRunStatus({
      messages: [{ ...message(""), error: "ERR_CONNECTION_CLOSED" }],
    }),
    "paused",
  );
});

test("recovers structured incomplete and blocked outcomes", () => {
  assert.equal(
    recoverTaskRunStatus({
      messages: [
        {
          ...message("部分结果"),
          completionResult: {
            kind: "incomplete",
            operations: [],
            missingOperations: ["coding:modify"],
            toolCalls: 0,
            successfulTools: 0,
            failedTools: 0,
            changedFiles: [],
            additions: 0,
            deletions: 0,
          },
        },
      ],
    }),
    "paused",
  );
  assert.equal(
    recoverTaskRunStatus({
      messages: [
        {
          ...message("等待输入"),
          completionResult: {
            kind: "blocked",
            operations: [],
            missingOperations: [],
            toolCalls: 1,
            successfulTools: 1,
            failedTools: 0,
            changedFiles: [],
            additions: 0,
            deletions: 0,
          },
        },
      ],
    }),
    "blocked",
  );
});

test("recovers structured failures with partial or empty output", () => {
  for (const failed of [
    { ...message("partial output"), error: "401 invalid api key" },
    { ...message(""), error: "invalid api key" },
  ]) {
    assert.equal(
      recoverTaskRunStatus({
        messages: [message("earlier result"), failed],
      }),
      "failed",
    );
  }
});

test("keeps an explicit cancelled run even when the last turn is incomplete", () => {
  assert.equal(
    recoverTaskRunStatus({
      runStatus: "cancelled",
      messages: [
        {
          ...message("partial output"),
          completionResult: {
            kind: "incomplete",
            operations: [],
            missingOperations: [],
            toolCalls: 0,
            successfulTools: 0,
            failedTools: 0,
            changedFiles: [],
            additions: 0,
            deletions: 0,
          },
        },
      ],
    }),
    "cancelled",
  );
});

test("rewrites persisted retryable disconnects into incomplete pauses", () => {
  const recovered = recoverRetryableDisconnectMessages([
    message("earlier result"),
    { ...message("partial output"), error: "upstream 502" },
    { ...message(""), error: "invalid api key" },
  ]);
  assert.equal(recovered[1].error, undefined);
  assert.equal(recovered[1].completionResult?.kind, "incomplete");
  assert.equal(recovered[1].completionResult?.notice, "upstream 502");
  assert.equal(recovered[2].error, "invalid api key");
  assert.equal(recovered[2].completionResult, undefined);
  assert.equal(
    recoverTaskRunStatus({
      runStatus: "failed",
      messages: recovered.slice(0, 2),
    }),
    "paused",
  );
  assert.equal(
    recoverTaskRunStatus({
      runStatus: "failed",
      messages: recovered,
    }),
    "failed",
  );
});

test("restores a visible error for a failed turn with only a user message", () => {
  const user: ChatMessage = {
    id: "user-1",
    role: "user",
    content: "continue",
    createdAt: 1,
  };
  const recovered = recoverOrphanedFailure([user], "failed", 10);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[1].role, "assistant");
  assert.match(recovered[1].error ?? "", /生成失败/);
  assert.equal(recoverOrphanedFailure(recovered, "failed", 20), recovered);
});

test("marks interrupted tool activities as failed", () => {
  const activity: AgentActivity = {
    id: "activity-1",
    requestId: "request-1",
    tool: "mysql_query",
    status: "running",
    title: "执行 SQL",
    startedAt: 1,
    input: {},
  };
  const [recovered] = recoverInterruptedActivities([activity], 10);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.completedAt, 10);
  assert.match(recovered.errorSummary ?? "", /中断/);
});

test("rejects stale task views during a conversation switch", () => {
  assert.equal(isTaskViewCurrent("task-b", "task-b", "task-b"), true);
  assert.equal(isTaskViewCurrent("task-b", "task-a", "task-b"), false);
  assert.equal(isTaskViewCurrent("task-a", "task-b", "task-a"), false);
});

test("a finished request cannot clear a newer queued request", () => {
  assert.deepEqual(finishTaskRequest("request-b", "request-a", "completed"), {
    runningId: "request-b",
    runStatus: "running",
  });
  assert.deepEqual(finishTaskRequest("request-a", "request-a", "completed"), {
    runningId: undefined,
    runStatus: "completed",
  });
  assert.deepEqual(finishTaskRequest(undefined, "request-a", "failed"), {
    runningId: undefined,
    runStatus: "failed",
  });
  assert.deepEqual(finishTaskRequest(undefined, "request-a", "blocked"), {
    runningId: undefined,
    runStatus: "blocked",
  });
});

test("finds queued work for an inactive task after its current request finishes", () => {
  const queuedUser = {
    id: "queued-2",
    role: "user" as const,
    content: "continue",
    createdAt: 2,
    queued: true,
  };
  assert.equal(
    nextQueuedMessageId({
      runningId: "request-1",
      runStatus: "running",
      messages: [queuedUser],
    }),
    undefined,
  );
  assert.equal(
    nextQueuedMessageId({
      runStatus: "completed",
      messages: [queuedUser],
    }),
    "queued-2",
  );
});
