import assert from "node:assert/strict";
import test from "node:test";
import {
  activityExecutionNarrative,
  nextExecutionNarrative,
  normalizeExecutionNarrative,
} from "../src/execution-narrative";
import type { AgentActivity } from "../src/types";

function activity(
  overrides: Partial<AgentActivity> & Pick<AgentActivity, "id" | "tool">,
): AgentActivity {
  return {
    requestId: "request-1",
    status: "success",
    title: "读取文件",
    startedAt: 1,
    input: {},
    ...overrides,
  };
}

test("keeps the model's concise execution explanation", () => {
  const item = activity({
    id: "step-1",
    tool: "read_file",
    narrative: "先确认当前实现，再决定最小修改范围。",
  });
  assert.equal(activityExecutionNarrative(item), item.narrative);
});

test("provides a useful fallback explanation for old activity records", () => {
  assert.match(
    activityExecutionNarrative(
      activity({
        id: "step-2",
        tool: "search_code",
        input: { query: "status" },
      }),
    ),
    /确认当前状态和关联实现/,
  );
});

test("makes recovery and next-step states explicit", () => {
  const failed = activity({
    id: "step-3",
    tool: "run_command",
    status: "failed",
    title: "运行测试",
  });
  assert.match(nextExecutionNarrative(failed, failed), /分析错误输出并调整/);
  assert.match(
    nextExecutionNarrative(activity({ id: "step-4", tool: "read_file" })),
    /核对结果并确定下一步/,
  );
});

test("bounds streamed narrative text without losing its beginning", () => {
  const value = normalizeExecutionNarrative("a".repeat(40), 12);
  assert.equal(value, "aaaaaaaaaaa…");
});
