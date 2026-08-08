import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyCooldownPool } from "./api-key-cooldown";

test("skips keys that are cooling down and restores them after expiry", () => {
  const pool = new ApiKeyCooldownPool(1_000);
  pool.markUnavailable("provider", 0, 10_000);
  assert.equal(pool.select("provider", 3, 10_500), 1);
  assert.equal(pool.select("provider", 3, 11_001), 0);
});

test("uses the soonest key when every key is cooling down", () => {
  const pool = new ApiKeyCooldownPool(1_000);
  pool.markUnavailable("provider", 0, 10_000);
  pool.markUnavailable("provider", 1, 9_900);
  assert.equal(pool.select("provider", 2, 10_100), 1);
  pool.markHealthy("provider", 0);
  assert.equal(pool.select("provider", 2, 10_100), 0);
});

test("cycles through every key once, including keys before the current index", () => {
  const pool = new ApiKeyCooldownPool(1_000);
  const tried = new Set<number>([1]);
  assert.equal(pool.next("provider", 3, 1, tried, 10_000), 2);
  tried.add(2);
  assert.equal(pool.next("provider", 3, 2, tried, 10_000), 0);
  tried.add(0);
  assert.equal(pool.next("provider", 3, 0, tried, 10_000), undefined);
});

test("prefers an untried healthy key over an earlier cooling key", () => {
  const pool = new ApiKeyCooldownPool(1_000);
  pool.markUnavailable("provider", 0, 10_000);
  assert.equal(pool.next("provider", 3, 2, new Set([2]), 10_100), 1);
});
