import test from "node:test";
import assert from "node:assert/strict";
import { executeMongo, redactMongoInput, shouldUseMongoTls } from "./mongodb";

test("redacts MongoDB URI, database, SSH, and TLS credentials", () => {
  assert.deepEqual(
    redactMongoInput({
      uri: "mongodb://app:p%40ss@db.example.com:27017/app?retryWrites=true",
      password: "secret",
      sshPassword: "ssh-secret",
      sshPrivateKey: "private-key",
      sshPassphrase: "key-passphrase",
      tlsCA: "C:/secrets/ca.pem",
      tlsCertificateKeyFile: "C:/secrets/client.pem",
    }),
    {
      uri: "mongodb://[已隐藏]@db.example.com:27017/app?retryWrites=true",
      password: "[已隐藏]",
      sshPassword: "[已隐藏]",
      sshPrivateKey: "[已隐藏]",
      sshPassphrase: "[已隐藏]",
      tlsCA: "[已隐藏]",
      tlsCertificateKeyFile: "[已隐藏]",
    },
  );
});

test("defaults public direct MongoDB to TLS but not private or tunneled hosts", () => {
  assert.equal(shouldUseMongoTls("mongo.example.com", false), true);
  assert.equal(shouldUseMongoTls("8.8.8.8", false), true);
  assert.equal(shouldUseMongoTls("127.0.0.1", false), false);
  assert.equal(shouldUseMongoTls("10.0.0.8", false), false);
  assert.equal(shouldUseMongoTls("mongo.example.com", true), false);
});

test("validates structured MongoDB operations before requiring a session", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    executeMongo(
      "missing",
      "request",
      { operation: "eval", collection: "items" },
      signal,
    ),
    /不支持的 MongoDB 操作/,
  );
  await assert.rejects(
    executeMongo(
      "missing",
      "request",
      { operation: "find", collection: "" },
      signal,
    ),
    /缺少 MongoDB collection/,
  );
  await assert.rejects(
    executeMongo(
      "missing",
      "request",
      { operation: "insertOne", collection: "items" },
      signal,
    ),
    /需要 document 对象/,
  );
  await assert.rejects(
    executeMongo(
      "missing",
      "request",
      { operation: "aggregate", collection: "items", pipeline: {} as never },
      signal,
    ),
    /pipeline 数组/,
  );
  await assert.rejects(
    executeMongo(
      "missing",
      "request",
      { operation: "distinct", collection: "items" },
      signal,
    ),
    /需要 field/,
  );
});
