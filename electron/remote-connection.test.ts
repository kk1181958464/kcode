import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_SUPERSEDED_CLOSE_CODE,
  shouldReconnectRemote,
} from "../src/remote-connection";

test("does not reconnect after another desktop instance takes over", () => {
  assert.equal(
    shouldReconnectRemote(true, false, REMOTE_SUPERSEDED_CLOSE_CODE),
    false,
  );
});

test("reconnects ordinary network closures only while enabled", () => {
  assert.equal(shouldReconnectRemote(true, false, 1006), true);
  assert.equal(shouldReconnectRemote(false, false, 1006), false);
  assert.equal(shouldReconnectRemote(true, true, 1006), false);
});
