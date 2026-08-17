import test from "node:test";
import assert from "node:assert/strict";
import type { SshRemoteProfile, SshRemoteState } from "../src/ssh-remote-types";
import {
  isSshRemoteCredentialsRequired,
  matchingSavedSshRemoteProfile,
  restoreSshRemoteConnection,
} from "../src/ssh-remote-recovery";

const workspace: SshRemoteProfile = {
  id: "old-profile",
  name: "production",
  host: "Example.COM",
  port: 22,
  username: "root",
  rootPath: "/srv/app/",
  authType: "private-key",
  remembered: false,
};

function disconnected(profile?: SshRemoteProfile): SshRemoteState {
  return {
    taskId: "task-1",
    connected: false,
    connecting: false,
    profile,
  };
}

test("matches a moved saved SSH profile by endpoint and remote root", () => {
  const candidate = {
    ...workspace,
    id: "saved-profile",
    host: "example.com",
    rootPath: "/srv/app",
    remembered: true,
  };
  assert.equal(
    matchingSavedSshRemoteProfile(workspace, [candidate])?.id,
    "saved-profile",
  );
});

test("does not guess between saved SSH profiles with the same endpoint", () => {
  const profiles = ["one", "two"].map((id, index) => ({
    ...workspace,
    id,
    rootPath: `/srv/app-${index}`,
    remembered: true,
  }));
  assert.equal(matchingSavedSshRemoteProfile(workspace, profiles), undefined);
});

test("restores a missing SSH profile id through a unique saved endpoint", async () => {
  const candidate = {
    ...workspace,
    id: "saved-profile",
    remembered: true,
  };
  const connected: SshRemoteState = {
    taskId: "task-1",
    connected: true,
    connecting: false,
    profile: candidate,
    cachePath: "C:\\cache\\saved-profile",
  };
  const connectedIds: string[] = [];
  const state = await restoreSshRemoteConnection(
    {
      state: async () => disconnected(),
      profiles: async () => [candidate],
      connectSaved: async (_taskId, profileId) => {
        connectedIds.push(profileId);
        return connected;
      },
    },
    "task-1",
    workspace,
  );
  assert.equal(state.connected, true);
  assert.deepEqual(connectedIds, ["saved-profile"]);
});

test("uses structured reconnect availability instead of matching error text", async () => {
  const current = {
    ...disconnected(workspace),
    reconnectAvailable: true,
  };
  const connectedIds: string[] = [];
  await restoreSshRemoteConnection(
    {
      state: async () => current,
      profiles: async () => [],
      connectSaved: async (_taskId, profileId) => {
        connectedIds.push(profileId);
        return { ...current, connected: true };
      },
    },
    "task-1",
    workspace,
  );
  assert.deepEqual(connectedIds, [workspace.id]);
});

test("requests credentials when neither runtime nor saved SSH data exists", async () => {
  await assert.rejects(
    restoreSshRemoteConnection(
      {
        state: async () => disconnected(),
        profiles: async () => [],
        connectSaved: async () => {
          throw new Error("unexpected connect");
        },
      },
      "task-1",
      workspace,
    ),
    (error) => isSshRemoteCredentialsRequired(error),
  );
});
