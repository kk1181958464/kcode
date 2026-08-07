import assert from "node:assert/strict";
import test from "node:test";
import { assertSshWriteExpectation } from "./ssh";

test("creates a remote file only when the path does not exist", () => {
  assert.doesNotThrow(() => assertSshWriteExpectation(false, "", null));
  assert.throws(
    () => assertSshWriteExpectation(true, "existing", null),
    /已经存在/,
  );
});

test("rejects a stale remote editor save", () => {
  assert.doesNotThrow(() => assertSshWriteExpectation(true, "saved", "saved"));
  assert.throws(
    () => assertSshWriteExpectation(true, "changed elsewhere", "saved"),
    /其他进程修改/,
  );
  assert.throws(
    () => assertSshWriteExpectation(false, "", "saved"),
    /其他进程修改/,
  );
});

test("keeps agent writes backward-compatible when no expectation is supplied", () => {
  assert.doesNotThrow(() =>
    assertSshWriteExpectation(true, "existing", undefined),
  );
});
