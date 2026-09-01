import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantRequestId,
  buildInterruptedRunRecoveryContext,
  recoveryActivitiesFromCheckpoint,
  recoveryCompletionResultFromCheckpoint,
  recoveryEvidenceFromActivities,
  recoveryPlanFromCompletionResult,
  recoveryPlanFromActivities,
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

test("restores a structured recovery plan independently of prose", () => {
  const plan = recoveryPlanFromActivities(
    [
      activity("req-plan", {
        tool: "update_plan",
        title: "更新执行计划",
        planSteps: ["检查现状", "修改文件"],
        planStatuses: ["completed", "in_progress"],
        planRequirements: [["inspect"], ["modify"]],
        planStep: 1,
      }),
    ],
    "req-plan",
  );
  assert.deepEqual(plan, {
    steps: [
      { step: "检查现状", status: "completed", requires: ["inspect"] },
      { step: "修改文件", status: "in_progress", requires: ["modify"] },
    ],
    current: 1,
    requirementsDeclared: true,
  });
});

test("restores successful runtime evidence without trusting prose or failures", () => {
  const evidence = recoveryEvidenceFromActivities(
    [
      activity("req-evidence", {
        tool: "write_file",
        title: "修改文件",
        path: "src/app.ts",
        changed: true,
        operationEvidence: ["modify"],
      }),
      activity("req-evidence", {
        tool: "run_command",
        title: "运行测试",
        command: "npm test",
        executed: true,
        exitCode: 0,
        operationEvidence: ["execute", "validate"],
      }),
      activity("req-evidence", {
        tool: "browser_open",
        title: "打开网页",
      }),
      activity("req-evidence", {
        tool: "browser_click",
        title: "点击网页",
        browserOperationEvidence: ["click"],
      }),
      activity("req-evidence", {
        tool: "browser_snapshot",
        title: "验证页面",
        browserOperationEvidence: ["verify"],
      }),
      activity("req-evidence", {
        tool: "ssh_upload_file",
        title: "上传文件",
        input: { localPath: "src/app.ts", remotePath: "/srv/app.ts" },
      }),
      activity("req-evidence", {
        tool: "write_file",
        title: "失败修改",
        status: "failed",
        changed: true,
      }),
    ],
    "req-evidence",
    {
      kind: "incomplete",
      operations: ["git:push"],
      missingOperations: [],
      toolCalls: 7,
      successfulTools: 6,
      failedTools: 1,
      changedFiles: ["src/app.ts"],
      additions: 1,
      deletions: 0,
    },
  );

  assert.deepEqual(evidence, {
    coding: ["inspect", "modify", "execute", "validate", "upload"],
    browser: ["open", "click", "verify"],
    git: ["push"],
  });
});

test("a newly opened page does not inherit old post-interaction verification", () => {
  const evidence = recoveryEvidenceFromActivities(
    [
      activity("req-browser", { tool: "browser_open", title: "打开登录页" }),
      activity("req-browser", {
        tool: "browser_click",
        title: "提交登录",
        browserOperationEvidence: ["click"],
      }),
      activity("req-browser", {
        tool: "browser_snapshot",
        title: "验证登录结果",
      }),
      activity("req-browser", { tool: "browser_open", title: "打开新页面" }),
    ],
    "req-browser",
  );

  assert.deepEqual(evidence, {
    coding: ["inspect"],
    browser: ["open", "click"],
    git: [],
  });
});

test("derives legacy recovery steps from structured missing operations", () => {
  const plan = recoveryPlanFromCompletionResult({
    kind: "incomplete",
    operations: ["coding:inspect"],
    missingOperations: ["coding:modify", "coding:validate", "git:push"],
    toolCalls: 3,
    successfulTools: 2,
    failedTools: 1,
    changedFiles: [],
    additions: 0,
    deletions: 0,
  });

  assert.deepEqual(plan, {
    steps: [
      { step: "完成实际修改", status: "pending", requires: ["modify"] },
      { step: "完成修改后验证", status: "pending", requires: ["validate"] },
    ],
    current: 0,
    requirementsDeclared: true,
  });
});

test("uses bounded checkpoint events when the task database is behind", () => {
  const events = [
    {
      type: "activity" as const,
      requestId: "req-checkpoint",
      activity: activity("req-checkpoint", {
        tool: "write_file",
        path: "src/new.ts",
        changed: true,
        operationEvidence: ["modify"],
      }),
    },
    {
      type: "done" as const,
      requestId: "req-checkpoint",
      result: {
        kind: "changed" as const,
        operations: ["coding:modify"],
        missingOperations: [],
        toolCalls: 1,
        successfulTools: 1,
        failedTools: 0,
        changedFiles: ["src/new.ts"],
        additions: 2,
        deletions: 0,
      },
    },
  ];
  const activities = recoveryActivitiesFromCheckpoint(events, "req-checkpoint");
  assert.equal(activities.length, 1);
  assert.equal(activities[0].path, "src/new.ts");
  assert.deepEqual(
    recoveryCompletionResultFromCheckpoint(events, "req-checkpoint"),
    events[1].result,
  );
  assert.equal(
    recoveryActivitiesFromCheckpoint(events, "other-request").length,
    0,
  );
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
