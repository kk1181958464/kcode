import assert from "node:assert/strict";
import test from "node:test";
import { executeProcessTool, type ProcessToolManager } from "./process-tools";

function memoryManager(): ProcessToolManager & {
  records: Map<string, { root: string; requestId: string; script: string; output: string; exitCode?: number }>;
} {
  const records = new Map<
    string,
    { root: string; requestId: string; script: string; output: string; exitCode?: number }
  >();
  let nextId = 1;
  return {
    records,
    async start(root, requestId, script) {
      if (!script) throw new Error("缺少进程命令");
      const id = `proc-${nextId++}`;
      records.set(id, { root, requestId, script, output: "" });
      return { id };
    },
    get(id, root) {
      const process = records.get(id);
      if (!process || process.root !== root)
        throw new Error("后台进程不存在或不属于当前工作区");
      return process;
    },
    async stop(id, root) {
      this.get(id, root);
      records.delete(id);
    },
  };
}

test("start_process records the command and process id", async () => {
  const manager = memoryManager();
  const result = await executeProcessTool(
    "/ws",
    "req-1",
    "start_process",
    { command: "npm test" },
    manager,
  );
  assert.equal(result.command, "npm test");
  assert.equal(result.executed, true);
  assert.deepEqual(result.operationEvidence, ["execute"]);
  assert.match(result.output, /processId: proc-1/);
  assert.equal(manager.records.get("proc-1")?.script, "npm test");
});

test("process_output reports running vs exited state", async () => {
  const manager = memoryManager();
  await executeProcessTool(
    "/ws",
    "req-1",
    "start_process",
    { command: "sleep 1" },
    manager,
  );
  const running = await executeProcessTool(
    "/ws",
    "req-1",
    "process_output",
    { processId: "proc-1" },
    manager,
  );
  assert.match(running.output, /状态: 运行中/);
  assert.equal(running.exitCode, undefined);
  assert.deepEqual(running.operationEvidence, ["execute"]);

  manager.records.get("proc-1")!.exitCode = 0;
  manager.records.get("proc-1")!.output = "done";
  const exited = await executeProcessTool(
    "/ws",
    "req-1",
    "process_output",
    { processId: "proc-1" },
    manager,
  );
  assert.match(exited.output, /状态: 已退出 \(0\)/);
  assert.equal(exited.exitCode, 0);
  assert.deepEqual(exited.operationEvidence, ["execute"]);
});

test("stop_process removes the record", async () => {
  const manager = memoryManager();
  await executeProcessTool(
    "/ws",
    "req-1",
    "start_process",
    { command: "sleep 1" },
    manager,
  );
  const stopped = await executeProcessTool(
    "/ws",
    "req-1",
    "stop_process",
    { processId: "proc-1" },
    manager,
  );
  assert.equal(stopped.output, "后台进程 proc-1 已停止");
  assert.deepEqual(stopped.operationEvidence, ["execute"]);
  assert.equal(manager.records.has("proc-1"), false);
});

test("rejects unknown process tools", async () => {
  await assert.rejects(
    () => executeProcessTool("/ws", "req-1", "run_command", {}),
    /不支持的进程工具/,
  );
});
