import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import {
  createServer as createMysqlServer,
  type Connection as MysqlServerConnection,
} from "mysql2";
import {
  connectMysql,
  disconnectMysql,
  queryMysql,
  redactMysqlInput,
  shouldUseMysqlTls,
} from "./mysql";

test("redacts MySQL and SSH tunnel credentials from activity input", () => {
  assert.deepEqual(
    redactMysqlInput({
      host: "10.0.0.5",
      username: "app",
      password: "database-password",
      sshHost: "gateway.example.com",
      sshUsername: "deploy",
      sshPassword: "ssh-password",
      sshPrivateKey: "private-key",
      sshPassphrase: "key-passphrase",
      sslKey: "tls-private-key",
      values: ["secret-value"],
      sql: "CREATE USER app IDENTIFIED BY 'secret'",
    }),
    {
      host: "10.0.0.5",
      username: "app",
      password: "[已隐藏]",
      sshHost: "gateway.example.com",
      sshUsername: "deploy",
      sshPassword: "[已隐藏]",
      sshPrivateKey: "[已隐藏]",
      sshPassphrase: "[已隐藏]",
      sslKey: "[已隐藏]",
      values: "[已隐藏 1 个参数]",
      sql: "[包含凭据的 SQL 已隐藏]",
    },
  );
});

test("defaults public direct MySQL to TLS but not private or tunneled hosts", () => {
  assert.equal(shouldUseMysqlTls("db.example.com", false), true);
  assert.equal(shouldUseMysqlTls("8.8.8.8", false), true);
  assert.equal(shouldUseMysqlTls("127.0.0.1", false), false);
  assert.equal(shouldUseMysqlTls("10.0.0.5", false), false);
  assert.equal(shouldUseMysqlTls("db.example.com", true), false);
});

test("cancels a pending MySQL handshake without registering a session", async () => {
  let closeSocket: (() => void) | undefined;
  let socketClosed: Promise<void> | undefined;
  const server = createNetServer((socket) => {
    closeSocket = () => socket.destroy();
    socketClosed = new Promise((resolve) => socket.once("close", resolve));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  const connecting = connectMysql(
    "cancel-task",
    "cancel-request",
    {
      host: "127.0.0.1",
      port: address.port,
      username: "test",
      password: "test",
    },
    false,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(connecting, /已取消/);
  assert.equal(await disconnectMysql("cancel-task"), false);
  const closedQuickly = await Promise.race([
    socketClosed?.then(() => true) ?? Promise.resolve(false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  closeSocket?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(closedQuickly, true);
});

test("streams and truncates a real MySQL protocol result set", async () => {
  const server = createMysqlServer();
  const serverConnections = new Set<MysqlServerConnection>();
  server.on("connection", (connection) => {
    serverConnections.add(connection);
    connection.on("error", () => undefined);
    connection.on("end", () => serverConnections.delete(connection));
    connection.on("query", () => {
      connection.writeTextResult(
        Array.from({ length: 1_505 }, (_, id) => ({ id })),
        [
          {
            catalog: "def",
            schema: "test",
            table: "items",
            orgTable: "items",
            name: "id",
            orgName: "id",
            characterSet: 45,
            columnLength: 11,
            columnType: 3,
            flags: 0,
            decimals: 0,
          },
        ],
      );
    });
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: "8.0.0-kcode-test",
      connectionId: 1,
      statusFlags: 2,
      characterSet: 45,
      capabilityFlags: 0x00ffffff,
      authCallback: (_auth: unknown, complete: (error?: Error) => void) =>
        complete(),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = (server as any)._server.address();
  const controller = new AbortController();
  await connectMysql(
    "stream-task",
    "stream-request",
    {
      host: "127.0.0.1",
      port: address.port,
      username: "test",
      password: "test",
    },
    false,
    controller.signal,
  );
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    const output = JSON.parse(
      await queryMysql(
        "stream-task",
        "stream-request",
        "SELECT id FROM items",
        [],
        controller.signal,
      ),
    );
    assert.equal(output.rowCount, 1_505);
    assert.equal(output.rows.length, 1_000);
    assert.equal(output.truncated, true);
  } finally {
    await disconnectMysql("stream-task");
    for (const connection of serverConnections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log = originalLog;
    console.error = originalError;
  }
});
