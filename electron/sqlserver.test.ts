import test from "node:test";
import assert from "node:assert/strict";
import { shouldEncryptSqlServer, shouldTrustSqlServerCertificate } from "./sqlserver";

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
