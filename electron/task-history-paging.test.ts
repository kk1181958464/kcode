import assert from "node:assert/strict";
import test from "node:test";
import {
  completePageMetadata,
  prependPageMetadata,
  prependUniqueItems,
  windowAfterPrepend,
} from "../src/task-history-paging";

test("prepends older task items without replacing newer in-memory values", () => {
  const result = prependUniqueItems(
    [
      { id: "m1", content: "old" },
      { id: "m2", content: "database" },
    ],
    [
      { id: "m2", content: "live" },
      { id: "m3", content: "latest" },
    ],
  );
  assert.deepEqual(result, [
    { id: "m1", content: "old" },
    { id: "m2", content: "live" },
    { id: "m3", content: "latest" },
  ]);
});

test("advances only the backward cursor when an older page is loaded", () => {
  assert.deepEqual(
    prependPageMetadata(
      {
        oldestCursor: "m3",
        newestCursor: "m6",
        hasMoreBefore: true,
        hasMoreAfter: false,
      },
      {
        items: [{ id: "m1" }, { id: "m2" }],
        oldestCursor: "m1",
        newestCursor: "m2",
        hasMoreBefore: false,
        hasMoreAfter: true,
      },
    ),
    {
      oldestCursor: "m1",
      newestCursor: "m6",
      hasMoreBefore: false,
      hasMoreAfter: false,
    },
  );
});

test("keeps the previous first turn mounted after prepending history", () => {
  assert.deepEqual(windowAfterPrepend({ start: 0, end: 8 }, 6, 14, 4), {
    start: 2,
    end: 14,
  });
  assert.deepEqual(completePageMetadata([{ id: "a" }, { id: "b" }]), {
    oldestCursor: "a",
    newestCursor: "b",
    hasMoreBefore: false,
    hasMoreAfter: false,
  });
});
