import assert from "node:assert/strict";
import test from "node:test";
import {
  extractExecutionPlan,
  sameExecutionPlan,
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

test("extracts consecutive numbered plans from model narration", () => {
  assert.deepEqual(
    extractExecutionPlan(
      "我会按顺序处理：\n1. 读取当前实现\n2. 修改相关文件\n3. 运行测试",
    ),
    ["读取当前实现", "修改相关文件", "运行测试"],
  );
  assert.deepEqual(extractExecutionPlan("第一步：检查状态\n第二步：应用修改"), [
    "检查状态",
    "应用修改",
  ]);
});

test("ignores an isolated numbered sentence", () => {
  assert.deepEqual(extractExecutionPlan("结论如下：\n1. 只有一项"), []);
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

test("compares plan revisions without relying on object identity", () => {
  assert.equal(sameExecutionPlan(["检查", "验证"], ["检查", "验证"]), true);
  assert.equal(sameExecutionPlan(["检查"], ["检查", "验证"]), false);
});
