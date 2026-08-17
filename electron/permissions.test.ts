import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCommandPolicy,
  isPermissionPolicyCustomized,
  permissionCategoriesForCommand,
  permissionCategoryForCommand,
  resolvePermissionDecision,
  resolvePermissionDecisionForCategories,
  tokenizeShellCommand,
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

test("classifies nested and remote command payloads from executable structure", () => {
  assert.deepEqual(
    permissionCategoriesForCommand(
      'powershell.exe -NoProfile -Command "git -C repo commit -m test; git push origin main"',
    ),
    ["gitPublish", "workspaceWrite", "runCommands"],
  );
  assert.deepEqual(permissionCategoriesForCommand("Remove-Item -Recurse out"), [
    "deletePaths",
    "runCommands",
  ]);
  assert.deepEqual(permissionCategoriesForCommand("Write-Output 'git push'"), [
    "runCommands",
  ]);
  assert.deepEqual(
    permissionCategoriesForCommand("gh workflow run package.yml"),
    ["gitPublish", "network", "runCommands"],
  );
});

test("combines command categories using the strictest configured policy", () => {
  const policy: PermissionPolicy = {
    ...confirmPolicy,
    runCommands: "allow",
    workspaceWrite: "allow",
    gitPublish: "confirm",
  };
  assert.deepEqual(
    resolvePermissionDecisionForCategories(
      "full-access",
      policy,
      permissionCategoriesForCommand("git commit -m test"),
    ),
    { decision: "confirm", category: "gitPublish" },
  );
  assert.deepEqual(
    resolvePermissionDecisionForCategories(
      "full-access",
      { ...policy, deletePaths: "deny" },
      permissionCategoriesForCommand("git reset --hard"),
    ),
    { decision: "deny", category: "deletePaths" },
  );
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

test("tokenizes quoted PowerShell paths and shell segments", () => {
  assert.deepEqual(
    tokenizeShellCommand('& "C:\\Program Files\\Git\\cmd\\git.exe" -C repo commit -m test; npm test'),
    [["C:\\Program Files\\Git\\cmd\\git.exe", "-C", "repo", "commit", "-m", "test"], ["npm", "test"]],
  );
});

test("matches allow and deny rules by token prefix", () => {
  const result = evaluateCommandPolicy("git status", [
    { action: "allow", match: ["git", "status"] },
    { action: "deny", match: ["git", "push"] },
  ]);
  assert.equal(result.action, "allow");
  assert.equal(
    evaluateCommandPolicy("git push origin main", [
      { action: "deny", match: ["git", "push"] },
    ]).action,
    "deny",
  );
});
