import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultExecutionPlan,
  fallbackExecutionPlanStep,
  decodeLiteralUnicodeEscapes,
  normalizePlanUpdate,
  summarizeExecutionPlan,
} from "../src/execution-plan";
import type { AgentActivity } from "../src/types";

function activity(
  overrides: Partial<AgentActivity> & Pick<AgentActivity, "id" | "tool">,
): AgentActivity {
  return {
    id: overrides.id,
    requestId: "request-1",
    tool: overrides.tool,
    status: "success",
    title: "步骤",
    startedAt: 1,
    input: {},
    ...overrides,
  };
}

test("validates structured plan updates", () => {
  assert.deepEqual(
    normalizePlanUpdate({
      explanation: "开始实现",
      plan: [
        { step: "检查当前实现", status: "completed", requires: ["inspect"] },
        { step: "修改相关文件", status: "in_progress", requires: ["modify"] },
        { step: "运行测试", status: "pending", requires: ["validate"] },
      ],
    }),
    {
      explanation: "开始实现",
      plan: [
        { step: "检查当前实现", status: "completed", requires: ["inspect"] },
        { step: "修改相关文件", status: "in_progress", requires: ["modify"] },
        { step: "运行测试", status: "pending", requires: ["validate"] },
      ],
    },
  );
  assert.throws(
    () =>
      normalizePlanUpdate({
        plan: [
          { step: "检查", status: "in_progress", requires: [] },
          { step: "修改", status: "in_progress", requires: ["modify"] },
        ],
      }),
    /最多只能有一个/,
  );
});

test("summarizes plan progress from activity results", () => {
  const planSteps = ["检查", "修改", "验证"];
  const summary = summarizeExecutionPlan([
    activity({ id: "one", tool: "read_file", planSteps, planStep: 0 }),
    activity({
      id: "two",
      tool: "apply_patch",
      status: "running",
      planSteps,
      planStep: 1,
    }),
  ]);
  assert.deepEqual(summary, {
    steps: planSteps,
    current: 1,
    statuses: ["completed", "running", "pending"],
  });
});

test("waiting tools do not complete an unexecuted plan step", () => {
  const planSteps = ["检查部署配置", "连接服务器", "启动并验证服务"];
  const summary = summarizeExecutionPlan([
    activity({ id: "inspect", tool: "read_file", planSteps, planStep: 0 }),
    activity({
      id: "blocked",
      tool: "report_no_change",
      planSteps,
      planStep: 1,
    }),
    activity({
      id: "waiting-input",
      tool: "request_user_input",
      planSteps,
      planStep: 1,
    }),
  ]);
  assert.deepEqual(summary, {
    steps: planSteps,
    current: 1,
    statuses: ["completed", "pending", "pending"],
  });
});

test("summarizes statuses emitted by update_plan", () => {
  const planSteps = ["检查", "修改", "验证"];
  assert.deepEqual(
    summarizeExecutionPlan([
      activity({
        id: "plan",
        tool: "update_plan",
        planSteps,
        planStatuses: ["completed", "in_progress", "pending"],
        planStep: 1,
      }),
    ]),
    {
      steps: planSteps,
      current: 1,
      statuses: ["pending", "pending", "pending"],
    },
  );
});

test("builds a fallback coding plan and maps concrete tools to its phases", () => {
  assert.deepEqual(defaultExecutionPlan(new Set(["inspect", "modify"])), [
    "检查当前实现并确认处理范围",
    "修改相关文件并记录实际差异",
    "运行验证并核对最终结果",
  ]);
  assert.equal(fallbackExecutionPlanStep("read_file", {}, 3, 0), 0);
  assert.equal(fallbackExecutionPlanStep("apply_patch", {}, 3, 0), 1);
  assert.equal(
    fallbackExecutionPlanStep(
      "run_command",
      { command: "npm run typecheck" },
      3,
      1,
    ),
    2,
  );
});


test("decodes literal unicode escapes in plan explanation and steps", () => {
  assert.equal(
    decodeLiteralUnicodeEscapes("\\u67e5\\u6e05\\u56fe\\u6587"),
    "查清图文",
  );
  const normalized = normalizePlanUpdate({
    explanation: "\\u67e5\\u6e05\\u56fe\\u6587\\u5bfc\\u822a",
    plan: [
      {
        step: "\\u68c0\\u67e5\\u5f53\\u524d\\u5b9e\\u73b0",
        status: "completed",
        requires: ["inspect"],
      },
      {
        step: "修改相关文件",
        status: "in_progress",
        requires: ["modify"],
      },
    ],
  });
  assert.equal(normalized.explanation, "查清图文导航");
  assert.equal(normalized.plan[0].step, "检查当前实现");
});
