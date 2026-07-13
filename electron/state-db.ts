import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

let database: DatabaseSync | undefined;
const databasePath = () => path.join(app.getPath("userData"), "kcode.sqlite");

function db() {
  if (!database) {
    database = new DatabaseSync(databasePath());
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    migrateLegacyTasks(database);
  }
  return database;
}

function migrateLegacyTasks(connection: DatabaseSync) {
  const count = connection
    .prepare("SELECT COUNT(*) AS total FROM tasks")
    .get() as {
    total: number;
  };
  if (count.total) return;
  const legacy = connection
    .prepare("SELECT value FROM app_state WHERE key = 'tasks'")
    .get() as { value?: string } | undefined;
  if (!legacy?.value) return;
  try {
    const tasks = JSON.parse(legacy.value);
    if (Array.isArray(tasks)) saveTasks(connection, tasks);
  } catch {
    // Keep malformed legacy state untouched for manual recovery.
  }
}

function saveTasks(connection: DatabaseSync, value: unknown[]) {
  const upsert = connection.prepare(
    "INSERT INTO tasks(id,value,position,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, position=excluded.position, updated_at=excluded.updated_at",
  );
  const ids = new Set<string>();
  connection.exec("BEGIN IMMEDIATE");
  try {
    value.forEach((task, position) => {
      if (
        !task ||
        typeof task !== "object" ||
        typeof (task as any).id !== "string"
      )
        throw new Error("任务数据缺少有效 ID");
      const id = (task as any).id as string;
      ids.add(id);
      upsert.run(id, JSON.stringify(task), position, Date.now());
    });
    const existing = connection.prepare("SELECT id FROM tasks").all() as {
      id: string;
    }[];
    const remove = connection.prepare("DELETE FROM tasks WHERE id = ?");
    for (const row of existing) if (!ids.has(row.id)) remove.run(row.id);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function loadState(key: string): unknown | null {
  if (key === "tasks") {
    const rows = db()
      .prepare("SELECT value FROM tasks ORDER BY position")
      .all() as {
      value: string;
    }[];
    return rows.map((row) => JSON.parse(row.value));
  }
  const row = db()
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ? JSON.parse(row.value) : null;
}

export function saveState(key: string, value: unknown) {
  if (key === "tasks") {
    if (!Array.isArray(value)) throw new Error("任务状态必须是数组");
    saveTasks(db(), value);
    return;
  }
  db()
    .prepare(
      "INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
    .run(key, JSON.stringify(value), Date.now());
}

const fileSize = (file: string) => (existsSync(file) ? statSync(file).size : 0);
export function stateStorageStats() {
  const file = databasePath();
  const row = db().prepare("SELECT COUNT(*) AS total FROM tasks").get() as {
    total: number;
  };
  return {
    tasks: row.total,
    bytes: fileSize(file) + fileSize(`${file}-wal`) + fileSize(`${file}-shm`),
    path: file,
  };
}

export function compactStateDatabase() {
  const connection = db();
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  return stateStorageStats();
}

export function closeStateDatabase() {
  database?.close();
  database = undefined;
}
