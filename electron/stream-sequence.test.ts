import assert from "node:assert/strict";
import test from "node:test";
import { acceptStreamSequence } from "../src/stream-sequence";

test("drops duplicate and delayed renderer events", () => {
  const sequences = new Map<string, number>();
  assert.equal(acceptStreamSequence(sequences, "request-1", 1), true);
  assert.equal(acceptStreamSequence(sequences, "request-1", 1), false);
  assert.equal(acceptStreamSequence(sequences, "request-1", 3), true);
  assert.equal(acceptStreamSequence(sequences, "request-1", 2), false);
  assert.equal(acceptStreamSequence(sequences, "request-2", 1), true);
});

test("keeps backward compatibility with unsequenced events", () => {
  assert.equal(acceptStreamSequence(new Map(), "legacy"), true);
});
