import assert from "node:assert/strict";
import test from "node:test";
import { BoundedSnapshotMap, textSnapshotBytes } from "./bounded-snapshot-map";

const snap = (chars: number) => ({ before: "x".repeat(chars), after: "" });

test("evicts oldest snapshots past the byte budget", () => {
  const map = new BoundedSnapshotMap(100, textSnapshotBytes);
  map.set("a", snap(20)); // 40 bytes
  map.set("b", snap(20));
  map.set("a", snap(20)); // re-set moves "a" to newest
  map.set("c", snap(20)); // 120 bytes -> evict "b"
  assert.deepEqual([...map.keys()], ["a", "c"]);
  assert.equal(map.bytes, 80);
  map.delete("a");
  assert.equal(map.bytes, 40);
});

test("keeps a single oversized snapshot so the latest edit stays undoable", () => {
  const map = new BoundedSnapshotMap(10, textSnapshotBytes);
  map.set("a", snap(2));
  map.set("big", snap(50));
  assert.deepEqual([...map.keys()], ["big"]);
  map.clear();
  assert.equal(map.bytes, 0);
});
