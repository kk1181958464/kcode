import assert from "node:assert/strict";
import test from "node:test";
import {
  activityExecutionNarrative,
  dedupeExecutionNarrative,
  executionNarrativePreview,
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

test("keeps intermediate execution narration concise without parsing plans", () => {
  assert.equal(
    executionNarrativePreview(
      "我会先确认当前实现，再开始修改。\n1. 检查代码\n2. 修改文件\n3. 运行测试",
    ),
    "我会先确认当前实现，再开始修改。\n1. 检查代码\n2. 修改文件\n3. 运行测试",
  );
  assert.equal(
    executionNarrativePreview(`准备执行：${"细节".repeat(240)}`).length <= 320,
    true,
  );
  assert.equal(
    executionNarrativePreview(
      "<thinking>private chain</thinking>\n1. 检查代码\n2. 修改文件",
    ),
    "1. 检查代码\n2. 修改文件",
  );
});

test("keeps only new narration when an adjacent tool round replays its prefix", () => {
  const previous =
    "本地处理逻辑存在一个明确风险，需要先查询最近记录确认问题所在。";
  assert.equal(
    dedupeExecutionNarrative(
      `${previous}确认问题后，我会修改对应文件并运行测试。`,
      previous,
    ),
    "确认问题后，我会修改对应文件并运行测试。",
  );
  assert.equal(dedupeExecutionNarrative(previous, previous), "");
});

test("deduplicates before preview clipping so later narration stays visible", () => {
  const previous = `先核对现状：${"已有说明".repeat(50)}`;
  const next = "现在开始修改目标文件，并在完成后执行真实验证。";
  assert.equal(
    executionNarrativePreview(
      dedupeExecutionNarrative(`${previous}${next}`, previous),
    ),
    next,
  );
});
