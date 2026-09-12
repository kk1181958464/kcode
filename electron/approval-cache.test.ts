import assert from "node:assert/strict";
import test from "node:test";

import { approvalCache } from "./approval-cache";

test("workspace-scoped approval rules require the same workspace", () => {
  approvalCache.clearSession();
  approvalCache.approve("npm test", "session", "runCommands", "D:/workspace");

  assert.equal(
    approvalCache.check("npm test", "runCommands", "D:/workspace"),
    "allow",
  );
  assert.equal(
    approvalCache.check("npm test", "runCommands", "D:/other"),
    "prompt",
  );
  assert.equal(
    approvalCache.check("npm test", "runCommands"),
    "prompt",
  );
  approvalCache.clearSession();
});