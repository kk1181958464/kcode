import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

let database: DatabaseSync | undefined;
function db() {
  if (!database) {
    database = new DatabaseSync(
      path.join(app.getPath("userData"), "kcode.sqlite"),
    );
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }
  return database;
}
export function loadState(key: string): unknown | null {
  const row = db()
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ? JSON.parse(row.value) : null;
}
export function saveState(key: string, value: unknown) {
  const json = JSON.stringify(value);
  db()
    .prepare(
      "INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
    .run(key, json, Date.now());
}
export function closeStateDatabase() {
  database?.close();
  database = undefined;
}
