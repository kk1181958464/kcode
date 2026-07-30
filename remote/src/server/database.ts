import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClientType, RemoteTaskSnapshot } from "./protocol.js";

type PayloadCodec = {
  encode(value: unknown): string;
  decode<T>(value: string): T;
};

export type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
  is_admin?: number;
};

export type SessionRow = {
  userId: string;
  username: string;
  clientType: ClientType;
  expiresAt: number;
  isAdmin: boolean;
};

export type AdminOverview = {
  users: number;
  activeSessions: number;
  devices: number;
  onlineDevices: number;
  tasks: number;
  configuredAccounts: number;
  commands24h: number;
  failedCommands24h: number;
};

export type AdminUserSummary = {
  id: string;
  username: string;
  createdAt: number;
  isAdmin: boolean;
  activeSessions: number;
  devices: number;
  onlineDevices: number;
  tasks: number;
  configured: boolean;
  configUpdatedAt?: number;
  lastSeen?: number;
};

export type AdminDeviceSummary = {
  id: string;
  userId: string;
  username: string;
  name: string;
  platform: string;
  version: string;
  online: boolean;
  lastSeen: number;
  createdAt: number;
  tasks: number;
};

export type AdminCommandSummary = {
  id: string;
  username: string;
  deviceName: string;
  commandType: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  error?: string;
};

export class RemoteDatabase {
  readonly connection: DatabaseSync;
  private readonly payloadCodec: PayloadCodec;

  constructor(file: string, payloadCodec?: PayloadCodec) {
    this.payloadCodec = payloadCodec ?? {
      encode: (value) => JSON.stringify(value),
      decode: <T>(value: string) => JSON.parse(value) as T,
    };
    mkdirSync(path.dirname(file), { recursive: true });
    this.connection = new DatabaseSync(file);
    this.connection.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        version TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, device_id, id)
      );
      CREATE TABLE IF NOT EXISTS account_config (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(user_id, device_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS commands_device ON commands(user_id, device_id, created_at DESC);
    `);
    const userColumns = this.connection
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string }>;
    if (!userColumns.some((column) => column.name === "is_admin"))
      this.connection.exec(
        "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
      );
    this.connection.exec(`
      UPDATE users SET is_admin=1
      WHERE id=(SELECT id FROM users ORDER BY created_at ASC,id ASC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM users WHERE is_admin=1)
    `);
  }

  userCount() {
    return Number(
      (
        this.connection
          .prepare("SELECT COUNT(*) AS total FROM users")
          .get() as {
          total: number;
        }
      ).total,
    );
  }

  createUser(user: UserRow) {
    this.connection
      .prepare(
        "INSERT INTO users(id,username,password_hash,password_salt,created_at,is_admin) VALUES(?,?,?,?,?,?)",
      )
      .run(
        user.id,
        user.username,
        user.password_hash,
        user.password_salt,
        user.created_at,
        user.is_admin ? 1 : 0,
      );
  }

  findUser(username: string) {
    return this.connection
      .prepare(
        "SELECT id,username,password_hash,password_salt,created_at,is_admin FROM users WHERE username = ? COLLATE NOCASE",
      )
      .get(username) as UserRow | undefined;
  }

  createSession(input: {
    tokenHash: string;
    userId: string;
    clientType: ClientType;
    expiresAt: number;
    now: number;
  }) {
    this.connection
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,client_type,expires_at,created_at,last_seen) VALUES(?,?,?,?,?,?)",
      )
      .run(
        input.tokenHash,
        input.userId,
        input.clientType,
        input.expiresAt,
        input.now,
        input.now,
      );
  }

  session(tokenHash: string, now: number): SessionRow | undefined {
    const row = this.connection
      .prepare(
        `SELECT s.user_id AS userId,u.username,s.client_type AS clientType,
                s.expires_at AS expiresAt,u.is_admin AS isAdmin
         FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(tokenHash, now) as
      (Omit<SessionRow, "isAdmin"> & { isAdmin: number }) | undefined;
    if (row) {
      this.connection
        .prepare("UPDATE sessions SET last_seen=? WHERE token_hash=?")
        .run(now, tokenHash);
      return { ...row, isAdmin: Boolean(row.isAdmin) };
    }
    return undefined;
  }

  isAdministrator(userId: string) {
    const row = this.connection
      .prepare("SELECT is_admin AS isAdmin FROM users WHERE id=?")
      .get(userId) as { isAdmin: number } | undefined;
    return Boolean(row?.isAdmin);
  }

  adminOverview(now: number): AdminOverview {
    const since = now - 24 * 60 * 60 * 1000;
    const row = this.connection
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM sessions WHERE expires_at>?) AS activeSessions,
          (SELECT COUNT(*) FROM devices) AS devices,
          (SELECT COUNT(*) FROM devices WHERE online=1) AS onlineDevices,
          (SELECT COUNT(*) FROM tasks) AS tasks,
          (SELECT COUNT(*) FROM account_config) AS configuredAccounts,
          (SELECT COUNT(*) FROM commands WHERE created_at>=?) AS commands24h,
          (SELECT COUNT(*) FROM commands WHERE created_at>=? AND status='failed') AS failedCommands24h`,
      )
      .get(now, since, since) as AdminOverview;
    return { ...row };
  }

  listAdminUsers(now: number): AdminUserSummary[] {
    const rows = this.connection
      .prepare(
        `SELECT u.id,u.username,u.created_at AS createdAt,u.is_admin AS isAdmin,
          (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS activeSessions,
          (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id) AS devices,
          (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.online=1) AS onlineDevices,
          (SELECT COUNT(*) FROM tasks t WHERE t.user_id=u.id) AS tasks,
          CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS configured,
          c.updated_at AS configUpdatedAt,
          MAX(
            COALESCE((SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id=u.id),0),
            COALESCE((SELECT MAX(d.last_seen) FROM devices d WHERE d.user_id=u.id),0)
          ) AS lastSeen
         FROM users u
         LEFT JOIN account_config c ON c.user_id=u.id
         ORDER BY u.created_at DESC`,
      )
      .all(now) as Array<
      Omit<AdminUserSummary, "isAdmin" | "configured"> & {
        isAdmin: number;
        configured: number;
        lastSeen: number;
      }
    >;
    return rows.map((row) => ({
      ...row,
      isAdmin: Boolean(row.isAdmin),
      configured: Boolean(row.configured),
      lastSeen: row.lastSeen || undefined,
      configUpdatedAt: row.configUpdatedAt || undefined,
    }));
  }

  listAdminDevices(): AdminDeviceSummary[] {
    const rows = this.connection
      .prepare(
        `SELECT d.id,d.user_id AS userId,u.username,d.name,d.platform,d.version,
                d.online,d.last_seen AS lastSeen,d.created_at AS createdAt,
                (SELECT COUNT(*) FROM tasks t WHERE t.user_id=d.user_id AND t.device_id=d.id) AS tasks
         FROM devices d JOIN users u ON u.id=d.user_id
         ORDER BY d.online DESC,d.last_seen DESC`,
      )
      .all() as Array<Omit<AdminDeviceSummary, "online"> & { online: number }>;
    return rows.map((row) => ({ ...row, online: Boolean(row.online) }));
  }

  listAdminCommands(limit = 30): AdminCommandSummary[] {
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const rows = this.connection
      .prepare(
        `SELECT c.id,u.username,COALESCE(d.name,c.device_id) AS deviceName,
                c.payload,c.status,c.result,c.created_at AS createdAt,c.updated_at AS updatedAt
         FROM commands c
         JOIN users u ON u.id=c.user_id
         LEFT JOIN devices d ON d.user_id=c.user_id AND d.id=c.device_id
         ORDER BY c.created_at DESC LIMIT ?`,
      )
      .all(boundedLimit) as Array<{
      id: string;
      username: string;
      deviceName: string;
      payload: string;
      status: string;
      result?: string;
      createdAt: number;
      updatedAt: number;
    }>;
    return rows.map((row) => {
      let commandType = "unknown";
      let error: string | undefined;
      try {
        const payload = this.payloadCodec.decode<{ type?: unknown }>(
          row.payload,
        );
        if (typeof payload.type === "string") commandType = payload.type;
      } catch {
        commandType = "unreadable";
      }
      if (row.result)
        try {
          const result = this.payloadCodec.decode<{ error?: unknown }>(
            row.result,
          );
          if (typeof result.error === "string")
            error = result.error.slice(0, 240);
        } catch {
          error = "结果记录无法读取";
        }
      return {
        id: row.id,
        username: row.username,
        deviceName: row.deviceName,
        commandType,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        durationMs: Math.max(0, row.updatedAt - row.createdAt),
        error,
      };
    });
  }

  revokeSession(tokenHash: string) {
    this.connection
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(tokenHash);
  }

  cleanExpiredSessions(now: number) {
    this.connection
      .prepare("DELETE FROM sessions WHERE expires_at<=?")
      .run(now);
  }

  upsertDevice(input: {
    userId: string;
    id: string;
    name: string;
    platform: string;
    version: string;
    online: boolean;
    now: number;
  }) {
    this.connection
      .prepare(
        `INSERT INTO devices(id,user_id,name,platform,version,online,last_seen,created_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id,id) DO UPDATE SET
           name=excluded.name,platform=excluded.platform,version=excluded.version,
           online=excluded.online,last_seen=excluded.last_seen`,
      )
      .run(
        input.id,
        input.userId,
        input.name,
        input.platform,
        input.version,
        input.online ? 1 : 0,
        input.now,
        input.now,
      );
  }

  setDeviceOnline(userId: string, id: string, online: boolean, now: number) {
    this.connection
      .prepare(
        "UPDATE devices SET online=?,last_seen=? WHERE user_id=? AND id=?",
      )
      .run(online ? 1 : 0, now, userId, id);
  }

  listDevices(userId: string) {
    return this.connection
      .prepare(
        `SELECT id,name,platform,version,online,last_seen AS lastSeen,created_at AS createdAt
         FROM devices WHERE user_id=? ORDER BY online DESC,last_seen DESC`,
      )
      .all(userId) as Array<{
      id: string;
      name: string;
      platform: string;
      version: string;
      online: number;
      lastSeen: number;
      createdAt: number;
    }>;
  }

  replaceTasks(userId: string, deviceId: string, tasks: RemoteTaskSnapshot[]) {
    const upsert = this.connection.prepare(
      `INSERT INTO tasks(id,user_id,device_id,payload,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(user_id,device_id,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`,
    );
    const existing = this.connection
      .prepare("SELECT id FROM tasks WHERE user_id=? AND device_id=?")
      .all(userId, deviceId) as { id: string }[];
    const incoming = new Set(tasks.map((task) => task.id));
    const remove = this.connection.prepare(
      "DELETE FROM tasks WHERE user_id=? AND device_id=? AND id=?",
    );
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks)
        upsert.run(
          task.id,
          userId,
          deviceId,
          this.payloadCodec.encode(task),
          task.updatedAt || Date.now(),
        );
      for (const row of existing)
        if (!incoming.has(row.id)) remove.run(userId, deviceId, row.id);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(userId: string, deviceId: string) {
    const rows = this.connection
      .prepare(
        "SELECT payload FROM tasks WHERE user_id=? AND device_id=? ORDER BY updated_at DESC",
      )
      .all(userId, deviceId) as { payload: string }[];
    return rows.map((row) =>
      this.payloadCodec.decode<RemoteTaskSnapshot>(row.payload),
    );
  }

  config(userId: string) {
    return this.connection
      .prepare(
        "SELECT ciphertext,updated_at AS updatedAt FROM account_config WHERE user_id=?",
      )
      .get(userId) as { ciphertext: string; updatedAt: number } | undefined;
  }

  saveConfig(userId: string, ciphertext: string, now: number) {
    this.connection
      .prepare(
        `INSERT INTO account_config(user_id,ciphertext,updated_at) VALUES(?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,
      )
      .run(userId, ciphertext, now);
  }

  createCommand(input: {
    id: string;
    userId: string;
    deviceId: string;
    payload: unknown;
    now: number;
  }) {
    this.connection
      .prepare(
        "INSERT INTO commands(id,user_id,device_id,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.userId,
        input.deviceId,
        this.payloadCodec.encode(input.payload),
        "sent",
        input.now,
        input.now,
      );
  }

  finishCommand(
    userId: string,
    id: string,
    status: "completed" | "failed",
    result: unknown,
    now: number,
  ) {
    this.connection
      .prepare(
        "UPDATE commands SET status=?,result=?,updated_at=? WHERE user_id=? AND id=?",
      )
      .run(status, this.payloadCodec.encode(result), now, userId, id);
  }

  close() {
    this.connection.close();
  }
}
