import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSshWorkspacePath,
  sshWorkspaceCommand,
} from "./ssh-remote-path";

test("resolves relative SSH paths inside the remote workspace", () => {
  assert.equal(
    resolveSshWorkspacePath("/srv/app", "src/main.ts"),
    "/srv/app/src/main.ts",
  );
  assert.equal(resolveSshWorkspacePath("/", "/etc/hosts"), "/etc/hosts");
});

test("rejects SSH paths that escape the configured remote root", () => {
  assert.throws(
    () => resolveSshWorkspacePath("/srv/app", "../secrets"),
    /必须位于当前 SSH 工作区内/,
  );
  assert.throws(
    () => resolveSshWorkspacePath("/srv/app", "/etc/passwd"),
    /必须位于当前 SSH 工作区内/,
  );
});

test("starts remote commands in the configured workspace", () => {
  assert.equal(
    sshWorkspaceCommand("/srv/user's app", "npm test"),
    "cd -- '/srv/user'\\''s app' && (npm test)",
  );
});
