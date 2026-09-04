import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRuntimeWorkspaceBindingInstruction,
  buildWorkspaceLocationInstruction,
  effectiveLocalWorkspacePath,
} from "./workspace-prompt";

const remote = {
  host: "203.0.113.8",
  port: 22,
  username: "deploy",
  rootPath: "/srv/payment",
};

test("keeps the explicit local project separate from the SSH cache", () => {
  const input = {
    executionRoot: "C:\\Users\\user\\AppData\\Roaming\\KCode\\ssh-workspaces\\task",
    localWorkspacePath: "D:\\projects\\payment",
    remoteWorkspace: remote,
  };

  assert.equal(
    effectiveLocalWorkspacePath(input),
    "D:\\projects\\payment",
  );
  const instruction = buildWorkspaceLocationInstruction(input);
  assert.match(instruction, /LOCAL PROJECT ROOT.*D:\\projects\\payment/);
  assert.match(instruction, /REMOTE PROJECT ROOT.*\/srv\/payment/);
  assert.match(instruction, /do not scan drive roots/i);
});

test("does not invent a local project for a pure SSH task", () => {
  const instruction = buildWorkspaceLocationInstruction({
    executionRoot: "C:\\Users\\user\\AppData\\Roaming\\KCode\\ssh-workspaces\\task",
    remoteWorkspace: remote,
  });

  assert.equal(
    effectiveLocalWorkspacePath({
      executionRoot: "C:\\cache",
      remoteWorkspace: remote,
    }),
    undefined,
  );
  assert.match(instruction, /LOCAL PROJECT ROOT: none is attached/);
  assert.match(instruction, /managed local cache/i);
});

test("runtime SSH binding tells the next model turn where each tool belongs", () => {
  const binding = buildRuntimeWorkspaceBindingInstruction(
    "D:\\projects\\payment",
    remote,
  );

  assert.match(binding, /<runtime_workspace_binding>/);
  assert.match(binding, /D:\\projects\\payment/);
  assert.match(binding, /deploy@203\.0\.113\.8:22/);
  assert.match(binding, /local file\/search\/edit\/Git\/run_command\/start_process tools/);
  assert.match(binding, /ssh_\* tools/);
});
