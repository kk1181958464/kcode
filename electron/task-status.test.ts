import test from "node:test";
import assert from "node:assert/strict";
import {
  isTaskViewCurrent,
  recoverOrphanedFailure,
  recoverInterruptedActivities,
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

test("does not infer completion from an earlier successful turn after failure", () => {
  assert.equal(
    recoverTaskRunStatus({
      messages: [message("earlier result"), message("请求失败：upstream 502")],
    }),
    "failed",
  );
});

test("recovers structured failures with partial or empty output", () => {
  for (const failed of [
    { ...message("partial output"), error: "upstream timeout" },
    { ...message(""), error: "upstream 502" },
  ]) {
    assert.equal(
      recoverTaskRunStatus({
        messages: [message("earlier result"), failed],
      }),
      "failed",
    );
  }
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
