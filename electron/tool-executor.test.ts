import assert from "node:assert/strict";
import test from "node:test";
import { executeWithProgress } from "./tool-executor";

test("executeWithProgress coalesces progress and returns the operation result", async () => {
  const seen: string[] = [];
  const execution = executeWithProgress(async (report) => {
    report("first");
    report("latest");
    return 42;
  });
  for await (const value of execution) seen.push(value);
  assert.deepEqual(seen, ["latest"]);
  assert.equal((await execution.next()).done, true);
});

test("executeWithProgress propagates operation failures", async () => {
  const execution = executeWithProgress(async () => {
    throw new Error("tool failed");
  });
  await assert.rejects(async () => {
    for await (const _value of execution) {
      // Consume the progress stream until the operation rejects.
    }
  }, /tool failed/);
});
