import assert from "node:assert/strict";
import test from "node:test";
import {
  browserStoragePartition,
  SHARED_BROWSER_PARTITION,
} from "./browser-profile";

test("uses one durable browser profile across task sessions", () => {
  assert.match(SHARED_BROWSER_PARTITION, /^persist:/);
  assert.equal(
    browserStoragePartition("task-a"),
    browserStoragePartition("task-b"),
  );
  assert.equal(
    browserStoragePartition("task-a:subagent-1"),
    SHARED_BROWSER_PARTITION,
  );
});
