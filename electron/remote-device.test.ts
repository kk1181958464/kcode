import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REMOTE_DEVICE_NAME_LENGTH,
  normalizeRemoteDeviceName,
} from "../src/remote-device";

test("normalizes a user-defined remote computer name", () => {
  assert.equal(normalizeRemoteDeviceName("  办公室主机  "), "办公室主机");
  assert.equal(
    normalizeRemoteDeviceName("a".repeat(MAX_REMOTE_DEVICE_NAME_LENGTH)),
    "a".repeat(MAX_REMOTE_DEVICE_NAME_LENGTH),
  );
});

test("rejects invalid remote computer names", () => {
  assert.throws(() => normalizeRemoteDeviceName("   "), /不能为空/);
  assert.throws(
    () =>
      normalizeRemoteDeviceName("a".repeat(MAX_REMOTE_DEVICE_NAME_LENGTH + 1)),
    /不能超过/,
  );
  assert.throws(() => normalizeRemoteDeviceName("电脑\n名称"), /控制字符/);
});
