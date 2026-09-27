import assert from "node:assert/strict";
import test from "node:test";
import { TurnSteeringQueue } from "./turn-steering";

test("drains steering input once and keeps requests isolated", () => {
  const queue = new TurnSteeringQueue();
  queue.open("a");
  queue.open("b");
  queue.push("a", "first");
  queue.push("a", "second");
  queue.push("b", "other");
  assert.deepEqual(queue.drain("a"), ["first", "second"]);
  assert.deepEqual(queue.drain("a"), []);
  assert.equal(queue.size("b"), 1);
});

test("notifies a runtime wait when new steering input arrives", () => {
  const queue = new TurnSteeringQueue();
  queue.open("a");
  queue.open("b");
  let notifications = 0;
  const unsubscribe = queue.subscribe("a", () => {
    notifications += 1;
  });
  queue.push("b", "other");
  queue.push("a", "continue differently");
  unsubscribe();
  queue.push("a", "after unsubscribe");
  assert.equal(notifications, 1);
});

test("rejects instructions before a task opens and after it closes", () => {
  const queue = new TurnSteeringQueue();
  assert.throws(() => queue.push("a", "too early"), /任务已结束/);
  queue.open("a");
  queue.push("a", "accepted");
  assert.deepEqual(queue.drain("a"), ["accepted"]);
  queue.clear("a");
  assert.throws(() => queue.push("a", "too late"), /任务已结束/);
  assert.equal(queue.size("a"), 0);
});
