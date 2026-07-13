import test from "node:test";
import assert from "node:assert/strict";
import { resolvePermissionDecision } from "../src/permissions";
import type { PermissionPolicy } from "../src/types";

const staleConfirmPolicy = Object.fromEntries(["workspaceWrite", "deletePaths", "runCommands", "longRunningProcesses", "network", "gitPublish"].map(key => [key, "confirm"])) as PermissionPolicy;

test("full access overrides stale per-category confirmation", () => {
  assert.equal(resolvePermissionDecision("full-access", staleConfirmPolicy, "network"), "allow");
  assert.equal(resolvePermissionDecision("full-access", staleConfirmPolicy, "workspaceWrite"), "allow");
});

test("confirm mode uses the category policy", () => {
  assert.equal(resolvePermissionDecision("confirm", { ...staleConfirmPolicy, network: "deny" }, "network"), "deny");
});
