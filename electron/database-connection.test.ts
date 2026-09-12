import assert from "node:assert/strict";
import test from "node:test";
import { connectWithPreparedSsh } from "./database-connection";

test("adopts a temporary SSH session after connection succeeds", async () => {
  const calls: string[] = [];
  const result = await connectWithPreparedSsh({
    prepared: { sessionId: "s1", temporary: true },
    connect: async (id) => { calls.push(`connect:${id}`); return "ok"; },
    adopt: (id) => calls.push(`adopt:${id}`),
    cleanup: (id) => calls.push(`cleanup:${id}`),
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["connect:s1", "adopt:s1"]);
});

test("cleans up a temporary SSH session when database connection fails", async () => {
  const calls: string[] = [];
  await assert.rejects(() => connectWithPreparedSsh({
    prepared: { sessionId: "s2", temporary: true },
    connect: async () => { throw new Error("failed"); },
    adopt: () => calls.push("adopt"),
    cleanup: async (id) => calls.push(`cleanup:${id}`),
  }), /failed/);
  assert.deepEqual(calls, ["cleanup:s2"]);
});

test("does not adopt or clean up a persistent SSH session", async () => {
  const calls: string[] = [];
  await connectWithPreparedSsh({
    prepared: { sessionId: "s3", temporary: false },
    connect: async () => "ok",
    adopt: () => calls.push("adopt"),
    cleanup: () => calls.push("cleanup"),
  });
  assert.deepEqual(calls, []);
});
