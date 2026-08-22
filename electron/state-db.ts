import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  compactTaskActivityPayloads,
  type DeferredActivityPayload,
} from "../src/activity-payload";
import { TASK_MESSAGE_PAGE_SIZE } from "../src/task-history-paging";
import type {
  AgentEventEnvelope,
  RuntimeEventPage,
  RuntimeTaskStatusSnapshot,
} from "../src/runtime-protocol";
import {
  createRuntimeEventEnvelope,
  isAgentEventEnvelope,
  runtimeThreadStatus,
  runtimeTurnStatus,
} from "../src/runtime-protocol";

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
        header TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_payloads (
        activity_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_messages (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, id),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS task_messages_position
        ON task_messages(task_id, position);
      CREATE TABLE IF NOT EXISTS task_activities (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, id),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS task_activities_position
        ON task_activities(task_id, position);
      CREATE INDEX IF NOT EXISTS task_activities_request
        ON task_activities(task_id, json_extract(value, '$.requestId'));
      CREATE TABLE IF NOT EXISTS runtime_events (
        event_order INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(request_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS runtime_events_task_order
        ON runtime_events(task_id, event_order);
      CREATE INDEX IF NOT EXISTS runtime_events_request_sequence
        ON runtime_events(request_id, sequence);
    `);
    ensureTaskHeaderColumn(database);
    migrateLegacyTasks(database);
    migrateTaskItems(database);
    backfillTaskHeaders(database);
  }
  return database;
}

const TASK_ITEMS_STORAGE_VERSION = 2;

type StoredTask = Record<string, unknown> & {
  id: string;
  messages?: unknown[];
  activities?: unknown[];
  _taskItemsStorageVersion?: number;
};

export type TaskItemTable = "task_messages" | "task_activities";
export type TaskItemSyncMode = "replace" | "merge";

function storedTask(value: unknown): StoredTask {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as any).id !== "string"
  )
    throw new Error("任务数据缺少有效 ID");
  return value as StoredTask;
}

function taskCore(value: unknown) {
  const task = storedTask(value);
  const {
    messages: _messages,
    activities: _activities,
    _taskItemsStorageVersion: _version,
    ...core
  } = task;
  return { ...core, _taskItemsStorageVersion: TASK_ITEMS_STORAGE_VERSION };
}

function taskItems(value: unknown, key: "messages" | "activities") {
  const items = storedTask(value)[key];
  return Array.isArray(items) ? items : [];
}

export function syncTaskItems(
  connection: DatabaseSync,
  table: TaskItemTable,
  taskId: string,
  items: unknown[],
  mode: TaskItemSyncMode = "replace",
) {
  const upsert = connection.prepare(
    `INSERT INTO ${table}(task_id,id,position,value,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(task_id,id) DO UPDATE SET
       position=excluded.position,
       value=excluded.value,
       updated_at=excluded.updated_at
     WHERE ${table}.position <> excluded.position OR ${table}.value <> excluded.value`,
  );
  const ids = new Set<string>();
  const now = Date.now();
  const existing = connection
    .prepare(`SELECT id,position FROM ${table} WHERE task_id = ?`)
    .all(taskId) as { id: string; position: number }[];
  const existingPositions = new Map(
    existing.map((row) => [row.id, row.position] as const),
  );
  let nextPosition = existing.reduce(
    (maximum, row) => Math.max(maximum, row.position + 1),
    0,
  );
  items.forEach((item, position) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as any).id !== "string"
    )
      throw new Error(`${table} 项缺少有效 ID`);
    const id = (item as any).id as string;
    ids.add(id);
    const storedPosition =
      mode === "merge"
        ? (existingPositions.get(id) ?? nextPosition++)
        : position;
    upsert.run(taskId, id, storedPosition, JSON.stringify(item), now);
  });
  if (mode === "merge") return;
  const remove = connection.prepare(
    `DELETE FROM ${table} WHERE task_id = ? AND id = ?`,
  );
  for (const row of existing) if (!ids.has(row.id)) remove.run(taskId, row.id);
}

function loadTaskItems(
  connection: DatabaseSync,
  table: TaskItemTable,
  taskId: string,
) {
  return (
    connection
      .prepare(`SELECT value FROM ${table} WHERE task_id = ? ORDER BY position`)
      .all(taskId) as { value: string }[]
  ).map((row) => JSON.parse(row.value));
}

function hydrateTask(connection: DatabaseSync, value: string) {
  const parsed = JSON.parse(value) as StoredTask;
  if (parsed._taskItemsStorageVersion !== TASK_ITEMS_STORAGE_VERSION)
    return parsed;
  const { _taskItemsStorageVersion: _version, ...core } = parsed;
  return {
    ...core,
    messages: loadTaskItems(connection, "task_messages", parsed.id),
    activities: loadTaskItems(connection, "task_activities", parsed.id),
  };
}

function migrateTaskItems(connection: DatabaseSync) {
  const rows = connection.prepare("SELECT id,value FROM tasks").all() as {
    id: string;
    value: string;
  }[];
  const pending = rows
    .map((row) => ({ ...row, task: JSON.parse(row.value) as StoredTask }))
    .filter(
      (row) => row.task._taskItemsStorageVersion !== TASK_ITEMS_STORAGE_VERSION,
    );
  if (!pending.length) return;
  const update = connection.prepare(
    "UPDATE tasks SET value = ?, header = ?, updated_at = ? WHERE id = ?",
  );
  connection.exec("BEGIN IMMEDIATE");
  try {
    for (const row of pending) {
      const compacted = compactTaskActivityPayloads(row.task);
      syncTaskItems(
        connection,
        "task_messages",
        row.id,
        taskItems(compacted.task, "messages"),
      );
      syncTaskItems(
        connection,
        "task_activities",
        row.id,
        taskItems(compacted.task, "activities"),
      );
      saveActivityPayloads(connection, row.id, compacted.payloads);
      update.run(
        JSON.stringify(taskCore(compacted.task)),
        JSON.stringify(taskHeader(compacted.task)),
        Date.now(),
        row.id,
      );
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

function ensureTaskHeaderColumn(connection: DatabaseSync) {
  const columns = connection.prepare("PRAGMA table_info(tasks)").all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "header"))
    connection.exec(
      "ALTER TABLE tasks ADD COLUMN header TEXT NOT NULL DEFAULT '{}'",
    );
}

function taskHeader(task: unknown) {
  if (!task || typeof task !== "object") return task;
  const {
    messages: _messages,
    activities: _activities,
    _taskItemsStorageVersion: _taskItemsStorageVersion,
    contextSummary: _contextSummary,
    contextLedger: _contextLedger,
    summarySnapshots: _summarySnapshots,
    imageSemantics: _imageSemantics,
    ...header
  } = task as Record<string, unknown>;
  return header;
}

function backfillTaskHeaders(connection: DatabaseSync) {
  const rows = connection
    .prepare("SELECT id,value FROM tasks WHERE header = '{}' OR header = ''")
    .all() as { id: string; value: string }[];
  if (!rows.length) return;
  const update = connection.prepare("UPDATE tasks SET header = ? WHERE id = ?");
  connection.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows)
      update.run(JSON.stringify(taskHeader(JSON.parse(row.value))), row.id);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
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
    "INSERT INTO tasks(id,value,header,position,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, header=excluded.header, position=excluded.position, updated_at=excluded.updated_at",
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
      const compacted = compactTaskActivityPayloads(task);
      upsert.run(
        id,
        JSON.stringify(taskCore(compacted.task)),
        JSON.stringify(taskHeader(compacted.task)),
        position,
        Date.now(),
      );
      syncTaskItems(
        connection,
        "task_messages",
        id,
        taskItems(compacted.task, "messages"),
      );
      syncTaskItems(
        connection,
        "task_activities",
        id,
        taskItems(compacted.task, "activities"),
      );
      saveActivityPayloads(connection, id, compacted.payloads);
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

function saveActivityPayloads(
  connection: DatabaseSync,
  taskId: string,
  payloads: DeferredActivityPayload[],
) {
  if (!payloads.length) return;
  const upsert = connection.prepare(
    "INSERT INTO activity_payloads(activity_id,task_id,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(activity_id) DO UPDATE SET task_id=excluded.task_id, value=excluded.value, updated_at=excluded.updated_at",
  );
  const now = Date.now();
  for (const item of payloads)
    upsert.run(item.activityId, taskId, JSON.stringify(item.payload), now);
}

export function listTaskHeaders() {
  const rows = db()
    .prepare("SELECT header FROM tasks ORDER BY position")
    .all() as { header: string }[];
  return rows.map((row) => JSON.parse(row.header));
}

export function renameTaskInDatabase(
  connection: DatabaseSync,
  id: string,
  name: string,
  updatedAt = Date.now(),
) {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 80)
    throw new Error("任务名称必须为 1 到 80 个字符");
  const row = connection
    .prepare("SELECT value,header FROM tasks WHERE id = ?")
    .get(id) as { value: string; header: string } | undefined;
  if (!row) throw new Error("找不到要重命名的任务");

  const value = JSON.parse(row.value) as Record<string, unknown>;
  const header = JSON.parse(row.header || "{}") as Record<string, unknown>;
  value.name = normalizedName;
  value.updatedAt = updatedAt;
  header.name = normalizedName;
  header.updatedAt = updatedAt;
  connection
    .prepare(
      "UPDATE tasks SET value = ?, header = ?, updated_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(value), JSON.stringify(header), updatedAt, id);
  return { name: normalizedName, updatedAt };
}

export function renameTask(id: string, name: string) {
  return renameTaskInDatabase(db(), id, name);
}

export function loadTask(id: string): unknown | null {
  const connection = db();
  const row = connection
    .prepare("SELECT value FROM tasks WHERE id = ?")
    .get(id) as { value: string } | undefined;
  return row?.value ? hydrateTask(connection, row.value) : null;
}

export type TaskItemPageOptions = {
  limit?: number;
  before?: string;
  after?: string;
};

export type TaskItemPage<T = unknown> = {
  items: T[];
  oldestCursor?: string;
  newestCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type TaskWindow = {
  task: unknown;
  paging: {
    messages: Omit<TaskItemPage, "items">;
    activities: Omit<TaskItemPage, "items">;
  };
};

export function loadTaskItemPage(
  connection: DatabaseSync,
  table: TaskItemTable,
  taskId: string,
  options: TaskItemPageOptions = {},
): TaskItemPage {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  if (options.before && options.after)
    throw new Error("分页游标不能同时指定 before 和 after");
  const cursor = options.before ?? options.after;
  let cursorPosition: number | undefined;
  if (cursor) {
    const row = connection
      .prepare(`SELECT position FROM ${table} WHERE task_id = ? AND id = ?`)
      .get(taskId, cursor) as { position: number } | undefined;
    if (!row) throw new Error("分页游标不存在");
    cursorPosition = row.position;
  }

  let rows: { id: string; position: number; value: string }[];
  if (options.after) {
    rows = connection
      .prepare(
        `SELECT id,position,value FROM ${table}
         WHERE task_id = ? AND position > ? ORDER BY position ASC LIMIT ?`,
      )
      .all(taskId, cursorPosition as number, limit) as typeof rows;
  } else {
    rows = connection
      .prepare(
        `SELECT id,position,value FROM ${table}
         WHERE task_id = ?${options.before ? " AND position < ?" : ""}
         ORDER BY position DESC LIMIT ?`,
      )
      .all(
        ...(options.before
          ? [taskId, cursorPosition as number, limit]
          : [taskId, limit]),
      ) as typeof rows;
    rows.reverse();
  }

  const oldest = rows[0];
  const newest = rows.at(-1);
  const hasMoreBefore = oldest
    ? Boolean(
        connection
          .prepare(
            `SELECT 1 FROM ${table} WHERE task_id = ? AND position < ? LIMIT 1`,
          )
          .get(taskId, oldest.position),
      )
    : false;
  const hasMoreAfter = newest
    ? Boolean(
        connection
          .prepare(
            `SELECT 1 FROM ${table} WHERE task_id = ? AND position > ? LIMIT 1`,
          )
          .get(taskId, newest.position),
      )
    : false;
  return {
    items: rows.map((row) => JSON.parse(row.value)),
    oldestCursor: oldest?.id,
    newestCursor: newest?.id,
    hasMoreBefore,
    hasMoreAfter,
  };
}

export function loadTaskMessagePage(
  taskId: string,
  options?: TaskItemPageOptions,
) {
  return loadTaskItemPage(db(), "task_messages", taskId, options);
}

export function loadTaskActivityPage(
  taskId: string,
  options?: TaskItemPageOptions,
) {
  return loadTaskItemPage(db(), "task_activities", taskId, options);
}

export function loadTaskActivitiesForRequestsFromDatabase(
  connection: DatabaseSync,
  taskId: string,
  requestIds: string[],
) {
  const uniqueIds = [...new Set(requestIds.filter(Boolean))].slice(0, 100);
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  return (
    connection
      .prepare(
        `SELECT value FROM task_activities
         WHERE task_id = ?
           AND json_extract(value, '$.requestId') IN (${placeholders})
         ORDER BY position ASC`,
      )
      .all(taskId, ...uniqueIds) as { value: string }[]
  ).map((row) => JSON.parse(row.value));
}

export function loadTaskActivitiesForRequests(
  taskId: string,
  requestIds: string[],
) {
  return loadTaskActivitiesForRequestsFromDatabase(db(), taskId, requestIds);
}

/**
 * Append-only runtime journal. The event id and request/sequence pair make
 * retries and reconnects idempotent without asking the renderer to reconcile
 * two competing snapshots.
 */
export function appendRuntimeEventsToDatabase(
  connection: DatabaseSync,
  events: readonly AgentEventEnvelope[],
) {
  if (!events.length) return;
  const insert = connection.prepare(
    `INSERT OR IGNORE INTO runtime_events
      (task_id, request_id, sequence, event_id, value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  connection.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events)
      insert.run(
        event.taskId,
        event.requestId,
        event.sequence,
        event.eventId,
        JSON.stringify(event),
        event.emittedAt,
      );
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function appendRuntimeEvents(events: readonly AgentEventEnvelope[]) {
  appendRuntimeEventsToDatabase(db(), events);
}

export type RuntimeEventPageOptions = {
  requestId?: string;
  afterSequence?: number;
  limit?: number;
};

function parseStoredRuntimeEvent(value: string) {
  try {
    const event = JSON.parse(value) as unknown;
    return isAgentEventEnvelope(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

export function loadRuntimeEventsFromDatabase(
  connection: DatabaseSync,
  taskId: string,
  options: RuntimeEventPageOptions = {},
): RuntimeEventPage {
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const afterSequence = Math.max(0, Math.floor(options.afterSequence ?? 0));
  const rows = options.requestId
    ? (connection
        .prepare(
          `SELECT value FROM runtime_events
           WHERE task_id = ? AND request_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(taskId, options.requestId, afterSequence, limit + 1) as {
        value: string;
      }[])
    : (connection
        .prepare(
          `SELECT value FROM runtime_events
           WHERE task_id = ?
           ORDER BY event_order ASC LIMIT ?`,
        )
        .all(taskId, limit + 1) as { value: string }[]);
  const hasMore = rows.length > limit;
  const events = rows
    .slice(0, limit)
    .map((row) => parseStoredRuntimeEvent(row.value))
    .filter((event): event is AgentEventEnvelope => Boolean(event));
  return {
    events,
    hasMore,
    nextSequence: options.requestId ? events.at(-1)?.sequence : undefined,
  };
}

export function loadRuntimeEvents(
  taskId: string,
  options: RuntimeEventPageOptions = {},
): RuntimeEventPage {
  return loadRuntimeEventsFromDatabase(db(), taskId, options);
}

export function runtimeEventStats(taskId?: string) {
  const row = taskId
    ? (db()
        .prepare(
          "SELECT COUNT(*) AS total, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM runtime_events WHERE task_id = ?",
        )
        .get(taskId) as { total: number; bytes: number })
    : (db()
        .prepare(
          "SELECT COUNT(*) AS total, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM runtime_events",
        )
        .get() as { total: number; bytes: number });
  return { events: Number(row.total), bytes: Number(row.bytes) };
}

export function loadRuntimeTaskStatusesFromDatabase(
  connection: DatabaseSync,
): RuntimeTaskStatusSnapshot[] {
  const rows = connection
    .prepare(
      `SELECT event.task_id, event.request_id, event.sequence,
              event.created_at, event.value
       FROM runtime_events event
       INNER JOIN (
         SELECT task_id, MAX(event_order) AS event_order
         FROM runtime_events
         GROUP BY task_id
       ) latest ON latest.event_order = event.event_order
       ORDER BY event.created_at DESC`,
    )
    .all() as {
    task_id: string;
    request_id: string;
    sequence: number;
    created_at: number;
    value: string;
  }[];
  return rows.flatMap((row) => {
    const event = parseStoredRuntimeEvent(row.value);
    return event
      ? [
          {
            taskId: row.task_id,
            requestId: row.request_id,
            status: runtimeThreadStatus(event),
            turnStatus: runtimeTurnStatus(event) ?? "in_progress",
            lastSequence: row.sequence,
            updatedAt: row.created_at,
          },
        ]
      : [];
  });
}

export function loadRuntimeTaskStatuses(): RuntimeTaskStatusSnapshot[] {
  return loadRuntimeTaskStatusesFromDatabase(db());
}

/** Mark turns left in progress by a previous main-process lifetime. */
export function interruptStaleRuntimeEventsInDatabase(
  connection: DatabaseSync,
  now = Date.now(),
) {
  const stale = loadRuntimeTaskStatusesFromDatabase(connection).filter(
    (status) => status.turnStatus === "in_progress",
  );
  if (!stale.length) return 0;
  appendRuntimeEventsToDatabase(
    connection,
    stale.map((status) =>
      createRuntimeEventEnvelope(
        {
          type: "error",
          message: "应用已重新启动，上一轮运行已中断",
          code: "cancelled",
          retryable: true,
          userAction: "retry",
        },
        {
          taskId: status.taskId,
          requestId: status.requestId,
          sequence: status.lastSequence + 1,
          emittedAt: now,
        },
      ),
    ),
  );
  return stale.length;
}

export function interruptStaleRuntimeEvents(now = Date.now()) {
  return interruptStaleRuntimeEventsInDatabase(db(), now);
}

function pageMetadata(page: TaskItemPage): Omit<TaskItemPage, "items"> {
  const { items: _items, ...metadata } = page;
  return metadata;
}

export function loadTaskWindow(id: string): TaskWindow | null {
  const connection = db();
  const row = connection
    .prepare("SELECT value FROM tasks WHERE id = ?")
    .get(id) as { value: string } | undefined;
  if (!row?.value) return null;
  const stored = storedTask(JSON.parse(row.value));
  const { _taskItemsStorageVersion: _version, ...core } = stored;
  const messages = loadTaskItemPage(connection, "task_messages", id, {
    limit: TASK_MESSAGE_PAGE_SIZE,
  });
  const requestIds = messages.items
    .map((message: any) => String(message?.id ?? ""))
    .filter((messageId) => messageId.startsWith("assistant:"))
    .map((messageId) => messageId.slice("assistant:".length));
  const activityItems = loadTaskActivitiesForRequestsFromDatabase(
    connection,
    id,
    requestIds,
  );
  const activityCount = Number(
    (
      connection
        .prepare(
          "SELECT COUNT(*) AS total FROM task_activities WHERE task_id = ?",
        )
        .get(id) as { total: number }
    ).total,
  );
  return {
    task: {
      ...core,
      messages: messages.items,
      activities: activityItems,
    },
    paging: {
      messages: pageMetadata(messages),
      activities: {
        oldestCursor: activityItems[0]?.id,
        newestCursor: activityItems.at(-1)?.id,
        hasMoreBefore: activityCount > activityItems.length,
        hasMoreAfter: false,
      },
    },
  };
}

export function loadActivityPayload(activityId: string): unknown | null {
  const row = db()
    .prepare("SELECT value FROM activity_payloads WHERE activity_id = ?")
    .get(activityId) as { value?: string } | undefined;
  return row?.value ? JSON.parse(row.value) : null;
}

export type SaveTaskOptions = { preserveUnloadedItems?: boolean };

export function saveTask(
  id: string,
  value: unknown,
  options: SaveTaskOptions = {},
) {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).id !== id
  )
    throw new Error("任务数据与任务 ID 不匹配");
  const connection = db();
  const compacted = compactTaskActivityPayloads(value);
  const current = connection
    .prepare("SELECT position FROM tasks WHERE id = ?")
    .get(id) as { position: number } | undefined;
  const position =
    current?.position ??
    Number(
      (
        connection
          .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM tasks")
          .get() as {
          next: number;
        }
      ).next,
    );
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection
      .prepare(
        "INSERT INTO tasks(id,value,header,position,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, header=excluded.header, updated_at=excluded.updated_at",
      )
      .run(
        id,
        JSON.stringify(taskCore(compacted.task)),
        JSON.stringify(taskHeader(compacted.task)),
        position,
        Date.now(),
      );
    syncTaskItems(
      connection,
      "task_messages",
      id,
      taskItems(compacted.task, "messages"),
      options.preserveUnloadedItems ? "merge" : "replace",
    );
    syncTaskItems(
      connection,
      "task_activities",
      id,
      taskItems(compacted.task, "activities"),
      options.preserveUnloadedItems ? "merge" : "replace",
    );
    saveActivityPayloads(connection, id, compacted.payloads);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function saveTaskOrder(ids: string[]) {
  const connection = db();
  const update = connection.prepare(
    "UPDATE tasks SET position = ? WHERE id = ?",
  );
  connection.exec("BEGIN IMMEDIATE");
  try {
    ids.forEach((id, position) => update.run(position, id));
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function deleteTask(id: string) {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare("DELETE FROM runtime_events WHERE task_id = ?").run(id);
    connection.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function loadState(key: string): unknown | null {
  if (key === "tasks") {
    const connection = db();
    const rows = connection
      .prepare("SELECT value FROM tasks ORDER BY position")
      .all() as {
      value: string;
    }[];
    return rows.map((row) => hydrateTask(connection, row.value));
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
