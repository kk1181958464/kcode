import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantRequestId,
  buildInterruptedRunRecoveryContext,
} from "../src/interrupted-run-context";
import type { AgentActivity, ChatMessage } from "../src/types";

const activity = (
  requestId: string,
  overrides: Partial<AgentActivity> = {},
): AgentActivity => ({
  id: crypto.randomUUID(),
  requestId,
  tool: "run_command",
  status: "success",
  title: "运行检查",
  startedAt: 1,
  input: {},
  command: "php -l index.php",
  output: "No syntax errors detected",
  ...overrides,
});

test("extracts the runtime request id from an assistant message", () => {
  const message: ChatMessage = {
    id: "assistant:req-42",
    role: "assistant",
    content: "partial",
    createdAt: 1,
  };
  assert.equal(assistantRequestId(message), "req-42");
});

test("restores only the interrupted request evidence and redacts secrets", () => {
  const context = buildInterruptedRunRecoveryContext(
    [
      activity("old", { output: "ignore me" }),
      activity("req-1", {
        path: "src/index.php",
        additions: 3,
        deletions: 1,
        output: "password=plain-secret\nvalidation passed",
      }),
      activity("req-1", {
        status: "failed",
        title: "启动服务",
        errorSummary: "端口已占用",
      }),
    ],
    "req-1",
  );
  assert.ok(context);
  assert.match(context, /src\/index\.php/);
  assert.match(context, /\+3 -1/);
  assert.match(context, /端口已占用/);
  assert.doesNotMatch(context, /plain-secret/);
  assert.doesNotMatch(context, /ignore me/);
});

test("does not invent recovery evidence when no activity was persisted", () => {
  assert.equal(buildInterruptedRunRecoveryContext([], "missing"), undefined);
});

test("aggregates the full run and preserves the latest unfinished structured plan", () => {
  const activities = Array.from({ length: 40 }, (_, index) =>
    activity("req-long", {
      title: `检查 ${index + 1}`,
      output: `检查结果 ${index + 1}`,
    }),
  );
  activities[4] = activity("req-long", {
    tool: "write_file",
    title: "修改核心文件",
    path: "src/core.ts",
    changed: true,
    additions: 7,
    deletions: 2,
    fileChanges: [{ path: "src/core.ts", additions: 7, deletions: 2 }],
  });
  activities[20] = activity("req-long", {
    tool: "update_plan",
    title: "更新执行计划",
    planSteps: ["完成实现", "运行回归测试", "整理最终结论"],
    planStatuses: ["completed", "in_progress", "pending"],
    planStep: 1,
  });
  activities[38] = activity("req-long", {
    status: "failed",
    title: "运行回归测试",
    errorSummary: "上游连接中断",
  });

  const context = buildInterruptedRunRecoveryContext(activities, "req-long");
  assert.ok(context);
  assert.match(context, /覆盖本轮全部 40 条活动/);
  assert.match(context, /src\/core\.ts \(\+7 -2\)/);
  assert.match(context, /\[已完成\] 完成实现/);
  assert.match(context, /\[失败\] 运行回归测试/);
  assert.match(context, /不会重复成功的修改|不要重复成功的修改/);
});
