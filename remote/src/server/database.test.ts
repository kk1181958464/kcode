import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RemoteDatabase } from "./database.js";

test("persists account sessions, devices, encrypted task payloads and config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-remote-"));
  const encoded: string[] = [];
  const database = new RemoteDatabase(path.join(directory, "remote.sqlite"), {
    encode(value) {
      const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
      encoded.push(payload);
      return payload;
    },
    decode<T>(value: string) {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
    },
  });
  try {
    database.createUser({
      id: "user-1",
      username: "owner",
      password_hash: "hash",
      password_salt: "salt",
      created_at: 1,
      is_admin: 1,
    });
    database.createSession({
      tokenHash: "token-hash",
      userId: "user-1",
      clientType: "desktop",
      expiresAt: 10_000,
      now: 2,
    });
    assert.deepEqual(database.session("token-hash", 3), {
      userId: "user-1",
      username: "owner",
      clientType: "desktop",
      expiresAt: 10_000,
      isAdmin: true,
    });

    database.upsertDevice({
      userId: "user-1",
      id: "device-1",
      name: "Office PC",
      platform: "win32",
      version: "0.2.44",
      online: true,
      now: 4,
    });
    assert.equal(database.listDevices("user-1")[0].online, 1);

    const task = {
      id: "task-1",
      name: "测试任务",
      workspaceName: "kcode",
      createdAt: 1,
      updatedAt: 5,
      messages: [],
      activities: [],
    };
    database.replaceTasks("user-1", "device-1", [task]);
    assert.deepEqual(database.listTasks("user-1", "device-1"), [task]);
    assert.ok(encoded.every((value) => !value.includes("测试任务")));

    database.saveConfig("user-1", "ciphertext", 6);
    assert.equal(database.config("user-1")?.ciphertext, "ciphertext");
    assert.equal(database.setting("registration_open"), undefined);
    database.saveSetting("registration_open", "true", 6);
    assert.equal(database.setting("registration_open"), "true");

    database.createCommand({
      id: "command-1",
      userId: "user-1",
      deviceId: "device-1",
      payload: { type: "task.send" },
      now: 7,
    });
    database.finishCommand(
      "user-1",
      "command-1",
      "failed",
      { ok: false, error: "upstream unavailable" },
      9,
    );
    assert.deepEqual(database.adminOverview(10), {
      users: 1,
      activeSessions: 1,
      devices: 1,
      onlineDevices: 1,
      tasks: 1,
      configuredAccounts: 1,
      commands24h: 1,
      failedCommands24h: 1,
    });
    assert.equal(database.listAdminUsers(10)[0].isAdmin, true);
    assert.equal(database.listAdminDevices()[0].tasks, 1);
    assert.deepEqual(database.listAdminCommands(5)[0], {
      id: "command-1",
      username: "owner",
      deviceName: "Office PC",
      commandType: "task.send",
      status: "failed",
      createdAt: 7,
      updatedAt: 9,
      durationMs: 2,
      error: "upstream unavailable",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates the oldest legacy account to administrator", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-legacy-"));
  const file = path.join(directory, "remote.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users VALUES ('older','owner','hash','salt',1);
    INSERT INTO users VALUES ('newer','member','hash','salt',2);
  `);
  legacy.close();

  const database = new RemoteDatabase(file);
  try {
    assert.equal(database.isAdministrator("older"), true);
    assert.equal(database.isAdministrator("newer"), false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists server settings across database restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-settings-"));
  const file = path.join(directory, "remote.sqlite");
  const first = new RemoteDatabase(file);
  first.saveSetting("registration_open", "true", 1);
  first.close();

  const reopened = new RemoteDatabase(file);
  try {
    assert.equal(reopened.setting("registration_open"), "true");
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});
