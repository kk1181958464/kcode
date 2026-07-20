import test from "node:test";
import assert from "node:assert/strict";
import { executeMongo, shouldUseMongoTls } from "./mongodb";

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
