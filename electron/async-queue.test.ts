import assert from "node:assert/strict";
import test from "node:test";
import { AsyncQueue } from "./async-queue";

test("retains an item pushed before the consumer waits", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.close();
  assert.deepEqual(await queue.next(), { value: 1, done: false });
  assert.deepEqual(await queue.next(), { value: undefined, done: true });
});

test("retains failure before the consumer waits", async () => {
  const queue = new AsyncQueue<number>();
  const error = new Error("stream stopped");
  queue.fail(error);
  await assert.rejects(queue.next(), error);
});

test("retains an undefined failure without leaving a waiter pending", async () => {
  const queue = new AsyncQueue<number>();
  const pending = queue.next();
  queue.fail(undefined);
  let rejected = false;
  try {
    await pending;
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
});

test("pushLatest coalesces replaceable progress", async () => {
  const queue = new AsyncQueue<string>();
  queue.pushLatest("old");
  queue.pushLatest("new");
  assert.deepEqual(await queue.next(), { value: "new", done: false });
});
