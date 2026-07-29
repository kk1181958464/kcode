import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedStreamingReasoning,
  groupActivitiesByContentOffset,
  STREAMING_REASONING_DOM_CHAR_LIMIT,
  STREAMING_REASONING_DOM_TRIM_TARGET,
} from "../src/conversation-rendering";

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
