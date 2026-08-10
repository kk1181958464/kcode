import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  appendRuntimeEventsToDatabase,
  interruptStaleRuntimeEventsInDatabase,
  loadRuntimeEventsFromDatabase,
  loadRuntimeTaskStatusesFromDatabase,
} from "./state-db";
import { createRuntimeEventEnvelope } from "../src/runtime-protocol";

function runtimeDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE runtime_events (
      event_order INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(request_id, sequence)
    );
    CREATE INDEX runtime_events_task_order
      ON runtime_events(task_id, event_order);
    CREATE INDEX runtime_events_request_sequence
      ON runtime_events(request_id, sequence);
  `);
  return database;
}

test("runtime journal appends idempotently and resumes by sequence", () => {
  const database = runtimeDatabase();
  const events = [
    createRuntimeEventEnvelope(
      { type: "progress", message: "working" },
      { taskId: "task-1", requestId: "request-1", sequence: 1, emittedAt: 10 },
    ),
    createRuntimeEventEnvelope(
      { type: "done" },
      { taskId: "task-1", requestId: "request-1", sequence: 2, emittedAt: 20 },
    ),
  ];
  appendRuntimeEventsToDatabase(database, events);
  appendRuntimeEventsToDatabase(database, events);

  const page = loadRuntimeEventsFromDatabase(database, "task-1", {
    requestId: "request-1",
    afterSequence: 1,
  });
  assert.deepEqual(
    page.events.map((event) => event.eventId),
    ["request-1:2"],
  );
  assert.equal(page.nextSequence, 2);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM runtime_events").get()
      ?.total,
    2,
  );
  database.close();
});

test("runtime journal restores the latest status for each task", () => {
  const database = runtimeDatabase();
  appendRuntimeEventsToDatabase(database, [
    createRuntimeEventEnvelope(
      { type: "done" },
      { taskId: "task-1", requestId: "request-1", sequence: 1, emittedAt: 10 },
    ),
    createRuntimeEventEnvelope(
      { type: "progress", message: "next turn" },
      { taskId: "task-1", requestId: "request-2", sequence: 1, emittedAt: 20 },
    ),
    createRuntimeEventEnvelope(
      { type: "error", message: "failed" },
      { taskId: "task-2", requestId: "request-3", sequence: 1, emittedAt: 30 },
    ),
    createRuntimeEventEnvelope(
      { type: "error", message: "任务已停止", code: "cancelled" },
      { taskId: "task-3", requestId: "request-4", sequence: 1, emittedAt: 40 },
    ),
  ]);

  assert.deepEqual(loadRuntimeTaskStatusesFromDatabase(database), [
    {
      taskId: "task-3",
      requestId: "request-4",
      status: "interrupted",
      turnStatus: "interrupted",
      lastSequence: 1,
      updatedAt: 40,
    },
    {
      taskId: "task-2",
      requestId: "request-3",
      status: "failed",
      turnStatus: "failed",
      lastSequence: 1,
      updatedAt: 30,
    },
    {
      taskId: "task-1",
      requestId: "request-2",
      status: "running",
      turnStatus: "in_progress",
      lastSequence: 1,
      updatedAt: 20,
    },
  ]);
  database.close();
});

test("startup interrupts only unfinished turns", () => {
  const database = runtimeDatabase();
  appendRuntimeEventsToDatabase(database, [
    createRuntimeEventEnvelope(
      { type: "progress", message: "working" },
      { taskId: "task-1", requestId: "request-1", sequence: 1, emittedAt: 10 },
    ),
    createRuntimeEventEnvelope(
      { type: "done", outcome: "blocked" },
      { taskId: "task-2", requestId: "request-2", sequence: 1, emittedAt: 20 },
    ),
  ]);

  assert.equal(interruptStaleRuntimeEventsInDatabase(database, 30), 1);
  assert.deepEqual(loadRuntimeTaskStatusesFromDatabase(database), [
    {
      taskId: "task-1",
      requestId: "request-1",
      status: "interrupted",
      turnStatus: "interrupted",
      lastSequence: 2,
      updatedAt: 30,
    },
    {
      taskId: "task-2",
      requestId: "request-2",
      status: "waiting",
      turnStatus: "completed",
      lastSequence: 1,
      updatedAt: 20,
    },
  ]);
  database.close();
});

test("a paused turn is not treated as waiting-for-input", () => {
  // Verification pauses (browser/git/coding could not be proven, or the round
  // limit was hit) emit outcome:"paused". They must derive a completed thread
  // status so the sidebar shows no "待补充" badge — that badge is reserved for
  // genuine request_user_input turns (outcome:"blocked" -> status "waiting").
  const database = runtimeDatabase();
  appendRuntimeEventsToDatabase(database, [
    createRuntimeEventEnvelope(
      { type: "done", outcome: "paused" },
      { taskId: "task-paused", requestId: "request-1", sequence: 1, emittedAt: 10 },
    ),
    createRuntimeEventEnvelope(
      { type: "done", outcome: "blocked" },
      { taskId: "task-blocked", requestId: "request-2", sequence: 1, emittedAt: 20 },
    ),
  ]);

  const statuses = loadRuntimeTaskStatusesFromDatabase(database);
  const paused = statuses.find((s) => s.taskId === "task-paused");
  const blocked = statuses.find((s) => s.taskId === "task-blocked");
  assert.equal(paused?.status, "completed");
  assert.equal(paused?.turnStatus, "completed");
  assert.equal(blocked?.status, "waiting");
  assert.equal(blocked?.turnStatus, "completed");
  // Neither turn is left in progress, so startup does not interrupt them.
  assert.equal(interruptStaleRuntimeEventsInDatabase(database, 30), 0);
  database.close();
});
