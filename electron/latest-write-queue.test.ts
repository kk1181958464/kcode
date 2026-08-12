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

test("still persists a value enqueued during a failed write", async () => {
  const written: number[] = [];
  const queue = new LatestWriteQueue<number>(async (value) => {
    written.push(value);
    if (value === 1) throw new Error("transient");
  });

  queue.enqueue(1);
  queue.enqueue(2);
  await queue.waitForIdle().catch(() => undefined);

  // The value enqueued during the failed write must not be dropped.
  assert.deepEqual(written, [1, 2]);
});

test("a later successful write clears a stale failure", async () => {
  let attempt = 0;
  const queue = new LatestWriteQueue<number>(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("transient");
  });

  queue.enqueue(1);
  queue.enqueue(2);
  await queue.waitForIdle(); // must not throw: the retry succeeded
});
