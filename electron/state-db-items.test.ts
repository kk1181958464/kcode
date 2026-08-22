import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  loadTaskActivitiesForRequestsFromDatabase,
  loadTaskItemPage,
  renameTaskInDatabase,
  syncTaskItems,
} from "./state-db";

function itemDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE task_messages (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(task_id, id)
    );
    CREATE TABLE task_activities (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(task_id, id)
    );
    CREATE INDEX task_activities_request
      ON task_activities(task_id, json_extract(value, '$.requestId'));
  `);
  return database;
}

function storedMessages(database: DatabaseSync) {
  return (
    database
      .prepare(
        "SELECT id,position,value FROM task_messages ORDER BY position ASC",
      )
      .all() as { id: string; position: number; value: string }[]
  ).map((row) => ({
    id: row.id,
    position: row.position,
    content: (JSON.parse(row.value) as { content: string }).content,
  }));
}

test("partial task saves preserve unloaded rows and append new items", () => {
  const database = itemDatabase();
  syncTaskItems(
    database,
    "task_messages",
    "task-1",
    [
      { id: "m1", content: "old" },
      { id: "m2", content: "before" },
    ],
    "replace",
  );
  syncTaskItems(
    database,
    "task_messages",
    "task-1",
    [
      { id: "m2", content: "updated" },
      { id: "m3", content: "new" },
    ],
    "merge",
  );
  assert.deepEqual(storedMessages(database), [
    { id: "m1", position: 0, content: "old" },
    { id: "m2", position: 1, content: "updated" },
    { id: "m3", position: 2, content: "new" },
  ]);

  syncTaskItems(
    database,
    "task_messages",
    "task-1",
    [{ id: "m3", content: "only" }],
    "replace",
  );
  assert.deepEqual(storedMessages(database), [
    { id: "m3", position: 0, content: "only" },
  ]);
  database.close();
});

test("renames only the task header and core without touching task items", () => {
  const database = itemDatabase();
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      header TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  database
    .prepare(
      "INSERT INTO tasks(id,value,header,position,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(
      "task-1",
      JSON.stringify({ id: "task-1", name: "旧名称", updatedAt: 1 }),
      JSON.stringify({ id: "task-1", name: "旧名称", updatedAt: 1 }),
      0,
      1,
    );
  syncTaskItems(database, "task_messages", "task-1", [
    { id: "m1", content: "保留的消息" },
  ]);

  assert.deepEqual(
    renameTaskInDatabase(database, "task-1", "  新任务名称  ", 42),
    { name: "新任务名称", updatedAt: 42 },
  );
  const row = database
    .prepare("SELECT value,header,updated_at FROM tasks WHERE id = ?")
    .get("task-1") as {
    value: string;
    header: string;
    updated_at: number;
  };
  assert.deepEqual(JSON.parse(row.value), {
    id: "task-1",
    name: "新任务名称",
    updatedAt: 42,
  });
  assert.deepEqual(JSON.parse(row.header), {
    id: "task-1",
    name: "新任务名称",
    updatedAt: 42,
  });
  assert.equal(row.updated_at, 42);
  assert.deepEqual(storedMessages(database), [
    { id: "m1", position: 0, content: "保留的消息" },
  ]);
  assert.throws(
    () => renameTaskInDatabase(database, "task-1", "   "),
    /1 到 80/,
  );
  database.close();
});

test("task item pages keep chronological order around cursors", () => {
  const database = itemDatabase();
  syncTaskItems(
    database,
    "task_messages",
    "task-1",
    Array.from({ length: 6 }, (_, index) => ({
      id: `m${index + 1}`,
      content: String(index + 1),
    })),
  );

  const latest = loadTaskItemPage(database, "task_messages", "task-1", {
    limit: 2,
  });
  assert.deepEqual(
    latest.items.map((item: any) => item.id),
    ["m5", "m6"],
  );
  assert.equal(latest.hasMoreBefore, true);
  assert.equal(latest.hasMoreAfter, false);

  const older = loadTaskItemPage(database, "task_messages", "task-1", {
    before: "m5",
    limit: 2,
  });
  assert.deepEqual(
    older.items.map((item: any) => item.id),
    ["m3", "m4"],
  );

  const newer = loadTaskItemPage(database, "task_messages", "task-1", {
    after: "m4",
    limit: 2,
  });
  assert.deepEqual(
    newer.items.map((item: any) => item.id),
    ["m5", "m6"],
  );
  database.close();
});

test("loads all activities belonging to the visible message requests", () => {
  const database = itemDatabase();
  syncTaskItems(database, "task_activities", "task-1", [
    { id: "a1", requestId: "r-old", title: "old" },
    { id: "a2", requestId: "r-visible", title: "first" },
    { id: "a3", requestId: "r-visible", title: "second" },
    { id: "a4", requestId: "r-new", title: "new" },
  ]);
  const activities = loadTaskActivitiesForRequestsFromDatabase(
    database,
    "task-1",
    ["r-visible"],
  ) as { id: string }[];
  assert.deepEqual(
    activities.map((activity) => activity.id),
    ["a2", "a3"],
  );
  const queryPlan = database
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT value FROM task_activities
       WHERE task_id = ? AND json_extract(value, '$.requestId') IN (?)`,
    )
    .all("task-1", "r-visible") as { detail: string }[];
  assert.match(
    queryPlan.map((row) => row.detail).join("\n"),
    /task_activities_request/,
  );
  database.close();
});
