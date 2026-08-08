import assert from "node:assert/strict";
import test from "node:test";
import { TurnSteeringQueue } from "./turn-steering";

test("drains steering input once and keeps requests isolated", () => {
  const queue = new TurnSteeringQueue();
  queue.push("a", "first");
  queue.push("a", "second");
  queue.push("b", "other");
  assert.deepEqual(queue.drain("a"), ["first", "second"]);
  assert.deepEqual(queue.drain("a"), []);
  assert.equal(queue.size("b"), 1);
});
