import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  getBlockReason,
  invalidateHookConfig,
  isBlocked,
  loadHookConfig,
  runHooks,
  type HookConfig,
} from "./hook-lifecycle";

function workspaceWithHooks(config: HookConfig | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kcode-hooks-"));
  if (config) {
    fs.mkdirSync(path.join(root, ".kcode"));
    fs.writeFileSync(
      path.join(root, ".kcode", "hooks.json"),
      JSON.stringify(config),
    );
  }
  invalidateHookConfig();
  return root;
}

const node = JSON.stringify(process.execPath);

test("returns no results when the workspace has no hooks.json", async () => {
  const root = workspaceWithHooks(null);
  assert.equal(loadHookConfig(root), null);
  assert.deepEqual(await runHooks("PreToolUse", { workspaceRoot: root }), []);
});

test("caches a missing config until invalidated", () => {
  const root = workspaceWithHooks(null);
  assert.equal(loadHookConfig(root), null);
  fs.mkdirSync(path.join(root, ".kcode"));
  fs.writeFileSync(
    path.join(root, ".kcode", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [] } }),
  );
  assert.equal(loadHookConfig(root), null);
  invalidateHookConfig();
  assert.deepEqual(loadHookConfig(root), { hooks: { Stop: [] } });
});

test("command hook output is parsed as JSON injection", async () => {
  const root = workspaceWithHooks({
    hooks: {
      PreToolUse: [
        {
          type: "command",
          matcher: "apply_patch",
          command: `${node} -e "console.log(JSON.stringify({inject: process.env.KCODE_TOOL_NAME}))"`,
        },
      ],
    },
  });
  const results = await runHooks("PreToolUse", {
    workspaceRoot: root,
    toolName: "apply_patch",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].allowed, true);
  assert.equal(results[0].inject, "apply_patch");

  const skipped = await runHooks("PreToolUse", {
    workspaceRoot: root,
    toolName: "read_file",
  });
  assert.deepEqual(skipped, []);
});

test("blocking hook with non-zero exit rejects with stderr as reason", async () => {
  const root = workspaceWithHooks({
    hooks: {
      PreToolUse: [
        {
          type: "command",
          blocking: true,
          command: `${node} -e "process.stderr.write('nope'); process.exit(3)"`,
        },
        { type: "prompt", content: "never reached" },
      ],
    },
  });
  const results = await runHooks("PreToolUse", {
    workspaceRoot: root,
    toolName: "shell",
  });
  assert.equal(results.length, 1);
  assert.equal(isBlocked(results), true);
  assert.equal(getBlockReason(results), "nope");
});

test("slow command hook times out without blocking the event loop", async () => {
  const root = workspaceWithHooks({
    hooks: {
      PreToolUse: [
        {
          type: "command",
          blocking: true,
          timeout: 300,
          command: `${node} -e "setTimeout(() => {}, 5000)"`,
        },
      ],
    },
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const started = Date.now();
  const results = await runHooks("PreToolUse", {
    workspaceRoot: root,
    toolName: "shell",
  });
  clearInterval(timer);
  assert.ok(Date.now() - started < 4_000);
  assert.ok(ticks > 3, `event loop was blocked (ticks=${ticks})`);
  assert.equal(isBlocked(results), true);
});

test("already cancelled runs do not execute hooks", async () => {
  const root = workspaceWithHooks({
    hooks: { PreToolUse: [{ type: "prompt", content: "must not run" }] },
  });
  const controller = new AbortController();
  const reason = new Error("cancelled before hooks");
  controller.abort(reason);
  await assert.rejects(
    runHooks("PreToolUse", { workspaceRoot: root, signal: controller.signal }),
    (error) => error === reason,
  );
});

test("cancellation interrupts a non-blocking command hook", async () => {
  const root = workspaceWithHooks({
    hooks: {
      PreToolUse: [
        {
          type: "command",
          command: `${node} -e "setTimeout(() => {}, 1000)"`,
          blocking: false,
        },
        { type: "prompt", content: "must not run after cancellation" },
      ],
    },
  });
  const controller = new AbortController();
  const pending = runHooks("PreToolUse", {
    workspaceRoot: root,
    signal: controller.signal,
  });
  const reason = new Error("cancelled during hook");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});
