import assert from "node:assert/strict";
import test from "node:test";
import { LatestWriteQueue } from "./latest-write-queue";

test("keeps only the latest pending write during a burst", async () => {
  const written: number[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new LatestWriteQueue<number>(async (value) => {
    written.push(value);
    if (value === 1) await firstBlocked;
  });

  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  releaseFirst();
  await queue.waitForIdle();

  assert.deepEqual(written, [1, 3]);
});
