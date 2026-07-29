import test from "node:test";
import assert from "node:assert/strict";
import {
  isPermissionPolicyCustomized,
  permissionCategoryForCommand,
  resolvePermissionDecision,
} from "../src/permissions";
import type { PermissionPolicy } from "../src/types";

const confirmPolicy = Object.fromEntries(
  [
    "workspaceWrite",
    "deletePaths",
    "runCommands",
    "longRunningProcesses",
    "network",
    "gitPublish",
  ].map((key) => [key, "confirm"]),
) as PermissionPolicy;

test("full access honors explicit per-category exceptions", () => {
  assert.equal(
    resolvePermissionDecision("full-access", undefined, "gitPublish"),
    "allow",
  );
  assert.equal(
    resolvePermissionDecision("full-access", confirmPolicy, "gitPublish"),
    "confirm",
  );
});

test("confirm mode uses the category policy", () => {
  assert.equal(
    resolvePermissionDecision(
      "confirm",
      { ...confirmPolicy, network: "deny" },
      "network",
    ),
    "deny",
  );
});

test("read-only remains a hard safety boundary", () => {
  assert.equal(
    resolvePermissionDecision(
      "read-only",
      { ...confirmPolicy, gitPublish: "allow" },
      "gitPublish",
    ),
    "deny",
  );
});

test("detects Git publish commands with global options and executable paths", () => {
  assert.equal(
    permissionCategoryForCommand("git push origin main"),
    "gitPublish",
  );
  assert.equal(
    permissionCategoryForCommand("git -C D:\\project commit -m test"),
    "gitPublish",
  );
  assert.equal(
    permissionCategoryForCommand(
      '& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main',
    ),
    "gitPublish",
  );
  assert.equal(permissionCategoryForCommand("git status"), "runCommands");
  assert.equal(permissionCategoryForCommand("git -C repo pull"), "network");
});

test("reports policy overrides as a custom permission setup", () => {
  const fullAccess = Object.fromEntries(
    Object.keys(confirmPolicy).map((key) => [key, "allow"]),
  ) as PermissionPolicy;
  assert.equal(isPermissionPolicyCustomized("full-access", fullAccess), false);
  assert.equal(
    isPermissionPolicyCustomized("full-access", {
      ...fullAccess,
      gitPublish: "confirm",
    }),
    true,
  );
});
