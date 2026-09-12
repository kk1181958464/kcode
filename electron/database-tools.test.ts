import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialDescriptor } from "./credential-vault";
import {
  connectionResultOutput,
  executeDatabaseTool,
  isSchemaMutationSql,
  mysqlConnectInput,
  prepareDatabaseSsh,
  type DatabaseToolContext,
  type DatabaseToolDeps,
} from "./database-tools";

function descriptor(
  partial: Partial<CredentialDescriptor> &
    Pick<CredentialDescriptor, "id" | "kind" | "name">,
): CredentialDescriptor {
  return {
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function memoryDb(overrides: Partial<DatabaseToolDeps> = {}): DatabaseToolDeps & {
  calls: string[];
  saved: CredentialDescriptor[];
  mysql: Record<string, unknown>;
} {
  const calls: string[] = [];
  const saved: CredentialDescriptor[] = [];
  const mysql: Record<string, unknown> = {};
  const sqlserver: Record<string, unknown> = {};
  const mongo: Record<string, unknown> = {};
  let sshConnected = false;
  let sshProfile: { name: string; remembered?: boolean } | undefined;
  return {
    calls,
    saved,
    mysql,
    async resolveCredentialProfile(kind, selector) {
      calls.push(`resolve:${kind}:${selector}`);
      if (selector === "via-ssh") {
        return {
          descriptor: descriptor({
            id: "c-ssh",
            kind,
            name: "via-ssh",
            viaSsh: true,
            sshCredentialName: "jump",
          }),
          payload: {
            host: "db.internal",
            username: "app",
            password: "secret",
            database: "appdb",
          },
        };
      }
      if (selector === "local-mysql") {
        return {
          descriptor: descriptor({
            id: "c-local",
            kind: "mysql",
            name: "local-mysql",
          }),
          payload: {
            host: "127.0.0.1",
            username: "root",
            password: "pw",
            database: "kcode",
          },
        };
      }
      throw new Error(`没有凭据 ${selector}`);
    },
    async saveCredentialProfile(input) {
      calls.push(`save:${input.kind}:${input.host}`);
      const stored = descriptor({
        id: `saved-${saved.length + 1}`,
        kind: input.kind,
        name: input.name || String(input.username || "saved"),
        host: input.host,
        username: input.username,
        database: input.database,
        viaSsh: input.viaSsh,
        sshCredentialName: input.sshCredentialName,
      });
      saved.push(stored);
      return stored;
    },
    async savedSshCredential(selector) {
      calls.push(`sshCred:${selector}`);
      return { id: "ssh-1", name: selector };
    },
    async connectSavedSshRemote(taskId, profileId, rootPath) {
      calls.push(`sshSaved:${taskId}:${profileId}:${rootPath ?? ""}`);
      sshConnected = true;
      sshProfile = { name: profileId === "ssh-1" ? "jump" : profileId, remembered: true };
    },
    async sshRemoteState() {
      return { connected: sshConnected, profile: sshProfile };
    },
    async connectSsh(sessionId, requestId, input) {
      calls.push(`sshConnect:${sessionId}:${input.host}`);
      sshConnected = true;
      return { connected: true };
    },
    async adoptActiveSshRemote(taskId, requestedRootPath, preferredName) {
      calls.push(`sshAdopt:${taskId}:${requestedRootPath}:${preferredName ?? ""}`);
      sshProfile = { name: preferredName || "jump", remembered: true };
      return { profile: sshProfile };
    },
    adoptSshSession(fromSessionId, toSessionId) {
      calls.push(`sshAdoptSession:${fromSessionId}->${toSessionId}`);
    },
    disconnectSsh(sessionId) {
      calls.push(`sshDisconnect:${sessionId}`);
      sshConnected = false;
      return true;
    },
    async connectMysql(sessionId, requestId, input, viaSsh) {
      calls.push(`mysqlConnect:${sessionId}:${input.host}:${viaSsh}`);
      mysql[sessionId] = input;
      return {
        host: input.host,
        port: input.port || 3306,
        username: input.username,
        database: input.database,
        viaSsh,
      };
    },
    async queryMysql(_sessionId, _requestId, sql, values) {
      calls.push(`mysqlQuery:${sql}:${JSON.stringify(values)}`);
      if (sql.toLowerCase().startsWith("update"))
        return JSON.stringify({ affectedRows: 2, changedRows: 2 });
      return JSON.stringify({ rows: [{ id: 1 }], rowCount: 1 });
    },
    async disconnectMysql(sessionId) {
      calls.push(`mysqlDisconnect:${sessionId}`);
      const existed = sessionId in mysql;
      delete mysql[sessionId];
      return existed;
    },
    adoptMysqlSession(fromSessionId, toSessionId) {
      calls.push(`mysqlAdopt:${fromSessionId}->${toSessionId}`);
      mysql[toSessionId] = mysql[fromSessionId];
      delete mysql[fromSessionId];
    },
    async connectSqlServer(sessionId, _requestId, input, viaSsh) {
      calls.push(`sqlConnect:${sessionId}:${input.host}:${viaSsh}`);
      sqlserver[sessionId] = input;
      return {
        host: input.host,
        port: input.port || 1433,
        username: input.username,
        database: input.database,
        viaSsh,
      };
    },
    async querySqlServer(_sessionId, _requestId, sql) {
      calls.push(`sqlQuery:${sql}`);
      return JSON.stringify({ rows: [], rowCount: 0 });
    },
    async disconnectSqlServer(sessionId) {
      calls.push(`sqlDisconnect:${sessionId}`);
      const existed = sessionId in sqlserver;
      delete sqlserver[sessionId];
      return existed;
    },
    adoptSqlServerSession(fromSessionId, toSessionId) {
      calls.push(`sqlAdopt:${fromSessionId}->${toSessionId}`);
    },
    async connectMongo(sessionId, _requestId, input, viaSsh) {
      calls.push(`mongoConnect:${sessionId}:${input.host}:${viaSsh}`);
      mongo[sessionId] = input;
      return {
        host: input.host,
        port: input.port || 27017,
        database: input.database,
        viaSsh,
      };
    },
    async executeMongo(_sessionId, _requestId, input) {
      calls.push(`mongoExec:${input.operation}`);
      if (input.operation === "insertOne") return "insertedCount: 1";
      return JSON.stringify({ documents: [], documentCount: 0 });
    },
    async disconnectMongo(sessionId) {
      calls.push(`mongoDisconnect:${sessionId}`);
      return sessionId in mongo;
    },
    adoptMongoSession(fromSessionId, toSessionId) {
      calls.push(`mongoAdopt:${fromSessionId}->${toSessionId}`);
    },
    classifyMysqlSql(sql) {
      return /^\s*select\b/i.test(sql) ? "read" : "write";
    },
    classifySqlServerSql(sql) {
      return /^\s*select\b/i.test(sql) ? "read" : "write";
    },
    ...overrides,
  };
}

function ctx(
  name: string,
  input: Record<string, unknown> = {},
): DatabaseToolContext {
  return {
    browserSessionId: "task-1",
    requestId: "req-1",
    activityId: "act-1",
    name,
    input,
    signal: new AbortController().signal,
  };
}

test("isSchemaMutationSql matches DDL prefixes", () => {
  assert.equal(isSchemaMutationSql("CREATE TABLE t (id int)"), true);
  assert.equal(isSchemaMutationSql(" alter table t add x int"), true);
  assert.equal(isSchemaMutationSql("SELECT 1"), false);
  assert.equal(isSchemaMutationSql("UPDATE t SET x=1"), false);
});

test("mysql_connect remembers a successful live connection", async () => {
  const deps = memoryDb();
  const result = await executeDatabaseTool(
    ctx("mysql_connect", {
      host: "db.example",
      username: "app",
      password: "secret",
      database: "appdb",
      name: "prod-mysql",
    }),
    deps,
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.host, "db.example");
  assert.equal(parsed.viaSsh, false);
  assert.deepEqual(parsed.credential, {
    kind: "mysql",
    name: "prod-mysql",
    stored: true,
  });
  assert.equal(deps.saved[0]?.name, "prod-mysql");
  assert.ok(deps.calls.includes("mysqlConnect:task-1:db.example:false"));
});

test("mysql_connect rejects a via-ssh credential on the direct tool", async () => {
  const deps = memoryDb();
  await assert.rejects(
    () =>
      executeDatabaseTool(
        ctx("mysql_connect", { credentialName: "via-ssh" }),
        deps,
      ),
    /需要通过 SSH 连接/,
  );
});

test("mysql_connect_via_ssh adopts a temporary jump session", async () => {
  const deps = memoryDb();
  const result = await executeDatabaseTool(
    ctx("mysql_connect_via_ssh", {
      host: "10.0.0.9",
      username: "app",
      password: "secret",
      database: "appdb",
      sshHost: "bastion",
      sshUsername: "jump",
      sshPassword: "pw",
    }),
    deps,
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.host, "10.0.0.9");
  assert.equal(parsed.viaSsh, true);
  assert.ok(
    deps.calls.includes("mysqlConnect:task-1:pending:act-1:10.0.0.9:true"),
  );
  assert.ok(deps.calls.some((item) => item.startsWith("sshConnect:task-1:pending:act-1:bastion")));
  assert.ok(deps.calls.includes("mysqlAdopt:task-1:pending:act-1->task-1"));
  assert.ok(deps.calls.includes("sshAdoptSession:task-1:pending:act-1->task-1"));
  assert.equal(parsed.credential.kind, "mysql");
});

test("mysql_connect_via_ssh cleans up when the database connect fails", async () => {
  const deps = memoryDb({
    async connectMysql() {
      throw new Error("db down");
    },
  });
  await assert.rejects(
    () =>
      executeDatabaseTool(
        ctx("mysql_connect_via_ssh", {
          host: "10.0.0.9",
          username: "app",
          password: "secret",
          sshHost: "bastion",
          sshUsername: "jump",
          sshPassword: "pw",
        }),
        deps,
      ),
    /db down/,
  );
  assert.ok(deps.calls.includes("mysqlDisconnect:task-1:pending:act-1"));
  assert.ok(deps.calls.includes("sshDisconnect:task-1:pending:act-1"));
  assert.equal(
    deps.calls.some((item) => item.startsWith("mysqlAdopt:")),
    false,
  );
});

test("mysql_query marks writes that actually changed rows", async () => {
  const deps = memoryDb();
  const select = await executeDatabaseTool(
    ctx("mysql_query", { sql: "SELECT 1", values: [1] }),
    deps,
  );
  assert.equal(select.command, "SELECT 1");
  assert.equal(select.mutationAttempted, false);
  assert.equal(select.changed, false);

  const update = await executeDatabaseTool(
    ctx("mysql_query", { sql: "UPDATE t SET x=1" }),
    deps,
  );
  assert.equal(update.mutationAttempted, true);
  assert.equal(update.changed, true);
});

test("prepareDatabaseSsh rejects mixed credential and live ssh input", async () => {
  const deps = memoryDb();
  await assert.rejects(
    () =>
      prepareDatabaseSsh(
        "task-1",
        "req-1",
        "act-1",
        { sshCredentialName: "jump", sshHost: "bastion" },
        undefined,
        new AbortController().signal,
        undefined,
        deps,
      ),
    /不能同时提供/,
  );
});

test("mongodb_execute reports mutation from insert output", async () => {
  const deps = memoryDb();
  const inserted = await executeDatabaseTool(
    ctx("mongodb_execute", { operation: "insertOne", collection: "users" }),
    deps,
  );
  assert.equal(inserted.executed, true);
  assert.equal(inserted.mutationAttempted, true);
  assert.equal(inserted.changed, true);

  const find = await executeDatabaseTool(
    ctx("mongodb_execute", { operation: "find", collection: "users" }),
    deps,
  );
  assert.equal(find.mutationAttempted, false);
  assert.equal(find.changed, false);
});

test("disconnect reports missing sessions", async () => {
  const deps = memoryDb();
  const missing = await executeDatabaseTool(ctx("mysql_disconnect"), deps);
  assert.equal(missing.output, "当前任务没有活动的 MySQL 连接");
  await executeDatabaseTool(
    ctx("mysql_connect", {
      host: "127.0.0.1",
      username: "root",
      password: "pw",
      remember: false,
    }),
    deps,
  );
  const closed = await executeDatabaseTool(ctx("mysql_disconnect"), deps);
  assert.equal(closed.output, "MySQL 连接已关闭");
});

test("connectionResultOutput includes public credential refs", () => {
  const output = JSON.parse(
    connectionResultOutput(
      { host: "db" },
      {
        credential: descriptor({
          id: "c1",
          kind: "mysql",
          name: "prod",
        }),
      },
    ),
  );
  assert.deepEqual(output.credential, {
    kind: "mysql",
    name: "prod",
    stored: true,
  });
});

test("mysqlConnectInput applies SSH localhost default", () => {
  const input = mysqlConnectInput({ username: "app", password: "x" }, "127.0.0.1");
  assert.equal(input.host, "127.0.0.1");
  assert.equal(input.port, 3306);
});
