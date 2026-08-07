import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ManagedProcessRegistry,
  type ManagedProcessRecord,
} from "./process-registry";

const record = (id: string, pid: number): ManagedProcessRecord => ({
  id,
  pid,
  requestId: `request-${id}`,
  workspacePath: "D:/workspace",
  startedAt: 1_000 + pid,
});

test("persists process records and removes completed processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-process-registry-"));
  const file = path.join(root, "runtime", "processes.json");
  const registry = new ManagedProcessRegistry(file, async () => undefined);

  await registry.register(record("one", 101));
  await registry.register(record("two", 102));
  assert.deepEqual(
    (await registry.snapshot()).map((item) => item.id),
    ["one", "two"],
  );

  await registry.remove("one");
  const stored = JSON.parse(await readFile(file, "utf8")) as {
    processes: ManagedProcessRecord[];
  };
  assert.deepEqual(
    stored.processes.map((item) => item.id),
    ["two"],
  );
});

test("recovers stale processes and clears the registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-process-recovery-"));
  const file = path.join(root, "processes.json");
  const stale = [record("one", 201), record("two", 202)];
  await writeFile(
    file,
    JSON.stringify({ version: 1, processes: stale }),
    "utf8",
  );
  const terminated: number[] = [];
  const registry = new ManagedProcessRegistry(file, async (item) => {
    terminated.push(item.pid);
  });

  assert.equal(await registry.recover(), 2);
  assert.deepEqual(terminated, [201, 202]);
  assert.deepEqual(await registry.snapshot(), []);
});

test("quarantines a corrupt registry instead of blocking startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-process-corrupt-"));
  const file = path.join(root, "processes.json");
  await writeFile(file, "{broken", "utf8");
  const registry = new ManagedProcessRegistry(file, async () => undefined);

  assert.equal(await registry.recover(), 0);
  assert.deepEqual(await registry.snapshot(), []);
});
