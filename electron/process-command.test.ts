import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyNetworkCommand,
  runSpawnedCommand,
  terminateChildProcess,
} from "./process-command";

const nodeSleepArgs = (seconds: number) => [
  "-e",
  `setTimeout(() => {}, ${seconds * 1000});`,
];

const nodeOutputArgs = [
  "-e",
  "process.stdout.write('hello-progress'); setTimeout(() => process.stdout.write('done-progress'), 400);",
];

test("cancels a long-running command without hanging", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 250);
  const result = await runSpawnedCommand({
    executable: process.execPath,
    args: nodeSleepArgs(60),
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 120_000,
  });
  assert.ok(Date.now() - started < 8_000, "cancel should finish quickly");
  assert.match(result.output, /命令已取消/);
  assert.equal(result.cancelled, true);
});

test("streams command output while the process is still running", async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  const resultPromise = runSpawnedCommand({
    executable: process.execPath,
    args: nodeOutputArgs,
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 20_000,
    onOutput: (output) => updates.push(output),
  });
  const result = await resultPromise;
  assert.match(result.output, /hello-progress/);
  assert.match(result.output, /done-progress/);
  assert.ok(updates.some((item) => item.includes("hello-progress")));
});

test("emits progress heartbeats while a command is silent", async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  const resultPromise = runSpawnedCommand({
    executable: process.execPath,
    args: nodeSleepArgs(6),
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 20_000,
    onOutput: (output) => updates.push(output),
  });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  controller.abort();
  const result = await resultPromise;
  assert.ok(
    updates.some((item) => item.includes("[进度]") && item.includes("没有新输出")),
    "silent commands should report progress heartbeats",
  );
  assert.match(result.output, /命令已取消/);
});

test("kills silent commands after idle timeout", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = await runSpawnedCommand({
    executable: process.execPath,
    args: nodeSleepArgs(60),
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 120_000,
    idleTimeoutMs: 800,
  });
  assert.ok(Date.now() - started < 6_000, "idle timeout should finish quickly");
  assert.equal(result.idleTimedOut, true);
  assert.match(result.output, /没有新输出，已判定卡住/);
});

test("detects network commands", () => {
  assert.equal(isLikelyNetworkCommand("ssh-keyscan -T 15 host"), true);
  assert.equal(isLikelyNetworkCommand("Get-ChildItem"), false);
});

test("terminates a child process handle safely when pid is missing", () => {
  let killed = false;
  terminateChildProcess({
    kill() {
      killed = true;
      return true;
    },
  });
  assert.equal(killed, true);
});
