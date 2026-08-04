import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedLiveText,
  mergeLiveContent,
  reconcileById,
  visibleMessageWindow,
} from "./mobile-ui";

test("renders only the latest mobile message window", () => {
  const result = visibleMessageWindow([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result, { hiddenCount: 2, items: [3, 4, 5] });
});

test("merges persisted and live text without replaying their overlap", () => {
  assert.equal(
    mergeLiveContent("已经完成检查。", "已经完成检查。开始修改。"),
    "已经完成检查。开始修改。",
  );
  assert.equal(
    mergeLiveContent("第一步完成。第二步正", "第二步正在执行。"),
    "第一步完成。第二步正在执行。",
  );
  assert.equal(mergeLiveContent("已有正文", "新的尾部"), "已有正文新的尾部");
});

test("bounds live text while preserving its newest Unicode content", () => {
  const value = `${"前".repeat(20)}😀最新结果`;
  const result = boundedLiveText(value, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "😀最新结果");
});

test("reuses unchanged snapshot items by id", () => {
  const first = { id: "a", value: 1 };
  const second = { id: "b", value: 2 };
  const result = reconcileById(
    [first, second],
    [
      { id: "a", value: 1 },
      { id: "b", value: 3 },
    ],
    (left, right) => left.value === right.value,
  );
  assert.equal(result[0], first);
  assert.notEqual(result[1], second);
});
