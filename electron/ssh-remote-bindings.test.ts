import assert from "node:assert/strict";
import test from "node:test";
import type { SshRemoteProfile } from "../src/ssh-remote-types";
import { SshRemoteTaskWorkspaceBindings } from "./ssh-remote-bindings";

const profile: SshRemoteProfile = {
  id: "shared-profile",
  name: "production",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  rootPath: "/srv/default",
  authType: "private-key",
  remembered: true,
};

test("isolates remote roots for tasks sharing one SSH profile", () => {
  const bindings = new SshRemoteTaskWorkspaceBindings();
  bindings.bind("task-a", { ...profile, rootPath: "/srv/app-a" });
  bindings.bind("task-b", { ...profile, rootPath: "/srv/app-b" });

  bindings.bind("task-b", { ...profile, rootPath: "/srv/app-b-next" });

  assert.equal(bindings.workspace("task-a")?.rootPath, "/srv/app-a");
  assert.equal(bindings.workspace("task-b")?.rootPath, "/srv/app-b-next");
  assert.equal(bindings.profileId("task-a"), profile.id);
});

test("removes every task binding when a shared profile is forgotten", () => {
  const bindings = new SshRemoteTaskWorkspaceBindings();
  bindings.bind("task-a", { ...profile, rootPath: "/srv/app-a" });
  bindings.bind("task-b", { ...profile, rootPath: "/srv/app-b" });

  assert.deepEqual(bindings.removeProfile(profile.id).sort(), ["task-a", "task-b"]);
  assert.equal(bindings.workspace("task-a"), undefined);
  assert.equal(bindings.workspace("task-b"), undefined);
});
