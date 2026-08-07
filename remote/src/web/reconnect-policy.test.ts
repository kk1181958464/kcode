import assert from "node:assert/strict";
import test from "node:test";
import { reconnectDelay } from "./reconnect-policy";

test("reconnects quickly and then backs off to a bounded delay", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => reconnectDelay(attempt)),
    [500, 1_000, 2_000, 3_000, 5_000, 8_000, 12_000, 12_000],
  );
});

test("does not schedule retries while the browser is offline", () => {
  assert.equal(reconnectDelay(0, false), undefined);
});

