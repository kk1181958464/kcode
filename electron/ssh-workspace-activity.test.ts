import assert from "node:assert/strict";
import test from "node:test";
import { sshWorkspaceRootFromActivity } from "../src/ssh-workspace-activity";

test("attaches an editable workspace after SSH connection or root selection succeeds", () => {
  assert.equal(
    sshWorkspaceRootFromActivity({
      tool: "ssh_connect",
      status: "success",
      path: "/srv/app",
    }),
    "/srv/app",
  );
  assert.equal(
    sshWorkspaceRootFromActivity({
      tool: "ssh_set_workspace",
      status: "success",
      path: " /opt/service ",
    }),
    "/opt/service",
  );
});

test("does not mount an editor for incomplete or unrelated activities", () => {
  assert.equal(
    sshWorkspaceRootFromActivity({
      tool: "ssh_connect",
      status: "running",
      path: "/srv/app",
    }),
    undefined,
  );
  assert.equal(
    sshWorkspaceRootFromActivity({
      tool: "ssh_run",
      status: "success",
      path: "/srv/app",
    }),
    undefined,
  );
});
