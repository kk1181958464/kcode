import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedStreamingReasoning,
  groupActivitiesByContentOffset,
  shouldShowAssistantTailState,
  STREAMING_REASONING_DOM_CHAR_LIMIT,
  STREAMING_REASONING_DOM_TRIM_TARGET,
  visibleAssistantContent,
} from "../src/conversation-rendering";

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

test("groups timeline activities in offset order while preserving insertion order", () => {
  const first = { id: "first", contentOffset: 8 };
  const second = { id: "second", contentOffset: 2 };
  const third = { id: "third", contentOffset: 8 };
  const before = { id: "before", contentOffset: -10 };
  const after = { id: "after", contentOffset: 100 };

  assert.deepEqual(
    groupActivitiesByContentOffset([first, second, third, before, after], 10),
    [
      [0, [before]],
      [2, [second]],
      [8, [first, third]],
      [10, [after]],
    ],
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
