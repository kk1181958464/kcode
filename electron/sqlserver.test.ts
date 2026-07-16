import test from "node:test";
import assert from "node:assert/strict";
import {
  redactSqlServerInput,
  shouldEncryptSqlServer,
  shouldTrustSqlServerCertificate,
} from "./sqlserver";

test("redacts SQL Server and SSH tunnel credentials from activity input", () => {
  assert.deepEqual(
    redactSqlServerInput({
      host: "10.0.0.5",
      username: "app",
      password: "database-password",
      sshHost: "gateway.example.com",
      sshUsername: "deploy",
      sshPassword: "ssh-password",
      sshPrivateKey: "private-key",
      sshPassphrase: "key-passphrase",
      values: ["secret-value", 42],
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
      values: "[已隐藏 2 个参数]",
      sql: "[包含凭据的 SQL 已隐藏]",
    },
  );
});

test("defaults public direct SQL Server to encryption", () => {
  assert.equal(shouldEncryptSqlServer("db.example.com", false), true);
  assert.equal(shouldEncryptSqlServer("8.8.8.8", false), true);
  assert.equal(shouldEncryptSqlServer("127.0.0.1", false), false);
  assert.equal(shouldEncryptSqlServer("10.0.0.5", false), false);
  assert.equal(shouldEncryptSqlServer("db.example.com", true), false);
});

test("trusts certificates by default only for local and private hosts", () => {
  assert.equal(shouldTrustSqlServerCertificate("localhost"), true);
  assert.equal(shouldTrustSqlServerCertificate("192.168.1.20"), true);
  assert.equal(shouldTrustSqlServerCertificate("::1"), true);
  assert.equal(shouldTrustSqlServerCertificate("db.example.com"), false);
  assert.equal(shouldTrustSqlServerCertificate("8.8.8.8"), false);
});
