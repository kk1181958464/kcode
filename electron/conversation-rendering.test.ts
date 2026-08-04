import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedStreamingReasoning,
  completedProcessDuration,
  completedProcessTextLength,
  groupActivitiesByTextOffset,
  shouldShowAssistantTailState,
  STREAMING_REASONING_DOM_CHAR_LIMIT,
  STREAMING_REASONING_DOM_TRIM_TARGET,
  visibleAssistantContent,
} from "../src/conversation-rendering";
import type { AgentActivity } from "../src/types";

function activity(id: string, textOffset?: number): AgentActivity {
  return {
    id,
    requestId: "request",
    tool: "git_status",
    status: "completed",
    title: id,
    startedAt: 1,
    completedAt: 2,
    input: {},
    textOffset,
  };
}

test("groups activities at the assistant text position where they occurred", () => {
  const groups = groupActivitiesByTextOffset(
    [activity("first", 12), activity("second", 12), activity("third", 28)],
    40,
  );
  assert.deepEqual(
    groups.map((group) => ({
      offset: group.offset,
      ids: group.activities.map((item) => item.id),
    })),
    [
      { offset: 12, ids: ["first", "second"] },
      { offset: 28, ids: ["third"] },
    ],
  );
});

test("keeps legacy activities after existing text and clamps partial live text", () => {
  assert.equal(
    groupActivitiesByTextOffset([activity("legacy")], 20)[0].offset,
    20,
  );
  assert.equal(
    groupActivitiesByTextOffset([activity("live", 100)], 20)[0].offset,
    20,
  );
});

test("keeps child activity offsets monotonic in the parent timeline", () => {
  const child = {
    ...activity("child", 2),
    subagentId: "agent-1",
  };
  const groups = groupActivitiesByTextOffset(
    [activity("parent", 12), child],
    40,
  );
  assert.deepEqual(
    groups.map((group) => ({
      offset: group.offset,
      ids: group.activities.map((item) => item.id),
    })),
    [{ offset: 12, ids: ["parent", "child"] }],
  );
});

test("splits the final answer after the last root tool and preserves legacy text", () => {
  const root = activity("root", 18);
  const child = {
    ...activity("child", 35),
    subagentId: "agent-1",
  };
  assert.equal(completedProcessTextLength([root, child], 48), 18);
  assert.equal(completedProcessTextLength([activity("legacy")], 48), 0);
});

test("uses the message completion time with an activity fallback", () => {
  const item = {
    ...activity("done", 2),
    startedAt: 1_500,
    completedAt: 3_000,
  };
  assert.equal(completedProcessDuration(1_000, 6_000, [item]), 5_000);
  assert.equal(completedProcessDuration(1_000, undefined, [item]), 2_000);
});

test("hides inline reasoning blocks from persisted assistant messages", () => {
  assert.equal(
    visibleAssistantContent(
      "先说明。<thinking>Verifying repository state</thinking>最终结论。",
    ),
    "先说明。最终结论。",
  );
  assert.equal(
    visibleAssistantContent("可见内容\n<THINK>尚未闭合的内部判断"),
    "可见内容\n",
  );
  assert.equal(
    visibleAssistantContent("普通文本 </thinking> 继续"),
    "普通文本  继续",
  );
});

test("keeps live progress at the response tail while tools are active", () => {
  assert.equal(shouldShowAssistantTailState(true), true);
  assert.equal(shouldShowAssistantTailState(false), false);
});

test("keeps streaming reasoning DOM bounded and preserves surrogate pairs", () => {
  const short = "推理中";
  assert.deepEqual(boundedStreamingReasoning(short), {
    text: short,
    truncated: false,
  });

  const prefixLength =
    STREAMING_REASONING_DOM_CHAR_LIMIT -
    STREAMING_REASONING_DOM_TRIM_TARGET +
    1;
  const long = `${"前".repeat(prefixLength)}😀${"后".repeat(
    STREAMING_REASONING_DOM_TRIM_TARGET - 1,
  )}`;
  const bounded = boundedStreamingReasoning(long);

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.startsWith("😀"), true);
  assert.equal(bounded.text.endsWith("后"), true);
  assert.equal(
    bounded.text.length <= STREAMING_REASONING_DOM_TRIM_TARGET + 1,
    true,
  );
});
