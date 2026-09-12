import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolName } from "../src/types";
import {
  failureSummary,
  isHardFailure,
  mutationPaths,
} from "./agent-command";
import type { ToolCall } from "./agent-types";

const call = (
  name: AgentToolName,
  input: Record<string, unknown> = {},
): ToolCall => ({
  id: "call-1",
  name,
  input,
});

test("failureSummary keeps database and most SSH errors verbatim", () => {
  assert.equal(
    failureSummary(call("mysql_query"), "Access denied for user"),
    "Access denied for user",
  );
  assert.equal(
    failureSummary(call("ssh_connect"), "Permission denied (publickey)."),
    "Permission denied (publickey).",
  );
});

test("failureSummary formats ssh_run, git and run_command failures", () => {
  assert.equal(
    failureSummary(call("ssh_run"), "stderr:\ncommand not found", 127),
    "远程命令执行失败，退出码 127：command not found",
  );
  assert.equal(
    failureSummary(call("git_status"), "stderr:\nfatal: not a git repository"),
    "Git 操作失败：fatal: not a git repository",
  );
  assert.equal(
    failureSummary(
      call("run_command", { command: "*** Begin Patch\n*** End Patch" }),
      "out",
      1,
    ),
    "补丁内容被当作 PowerShell 命令执行。请直接使用“应用补丁”工具。",
  );
  assert.equal(
    failureSummary(
      call("run_command", { command: "foo" }),
      "foo : The term 'foo' is not recognized",
      1,
    ),
    "命令或程序不存在，请检查名称以及是否已安装。",
  );
  assert.equal(
    failureSummary(
      call("run_command", { command: "npm test" }),
      "stderr:\n1 failing",
      1,
    ),
    "命令执行失败，退出码 1：1 failing",
  );
});

test("failureSummary uses file-tool labels and keeps fetch timeouts", () => {
  assert.equal(failureSummary(call("write_file"), "EACCES"), "文件写入失败。");
  assert.equal(
    failureSummary(call("fetch_url"), "网页读取超时"),
    "网页读取超时",
  );
  assert.equal(failureSummary(call("web_search"), "other"), "工具执行失败。");
});

test("isHardFailure treats unknown tools as hard and run_command as soft unless blocked", () => {
  assert.equal(isHardFailure(call("write_file"), "EACCES"), true);
  assert.equal(
    isHardFailure(call("run_command", { command: "npm test" }), "1 failing"),
    false,
  );
  assert.equal(
    isHardFailure(
      call("run_command", { command: "foo" }),
      "CommandNotFoundException",
    ),
    true,
  );
  assert.equal(
    isHardFailure(
      call("run_command", { command: "npm test" }),
      "命令执行超时",
    ),
    true,
  );
  assert.equal(
    isHardFailure(
      call("ssh_run", { command: "git status" }),
      "fatal: not a git repository (or any of the parent directories): .git",
    ),
    false,
  );
  assert.equal(
    isHardFailure(call("ssh_run", { command: "ls" }), "Permission denied"),
    true,
  );
});

test("mutationPaths extracts patch, move and single-path mutations", () => {
  assert.deepEqual(
    mutationPaths(
      call("apply_patch", {
        patch:
          "*** Add File: src/a.ts\n+ok\n*** Update File: src/b.ts\n*** Delete File: src/c.ts\n",
      }),
    ),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );
  assert.deepEqual(
    mutationPaths(call("move_path", { from: "a.ts", to: "b.ts" })),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(mutationPaths(call("write_file", { path: "a.ts" })), [
    "a.ts",
  ]);
  assert.deepEqual(mutationPaths(call("read_file", { path: "a.ts" })), []);
});
