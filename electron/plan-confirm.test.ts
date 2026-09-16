import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlanConfirmGatedTool,
  isPlanConfirmMode,
  planConfirmInstruction,
  planRequiresUserGoAhead,
} from "./collaboration";
import type { ModelRequest } from "../src/types";
import { createRunState } from "./agent-run-state";

const base: ModelRequest = {
  providerId: "p",
  modelId: "m",
  messages: [],
  permissionMode: "full-access",
  workspacePath: "/tmp/demo",
};

test("plan-confirm mode is off by default and on for collaboration flag", () => {
  assert.equal(isPlanConfirmMode(base), false);
  assert.equal(
    isPlanConfirmMode({ ...base, collaboration: { mode: "plan-confirm" } }),
    true,
  );
  assert.equal(
    isPlanConfirmMode({
      ...base,
      collaboration: {
        mode: "planner-executor",
        executor: {
          providerId: "e",
          modelId: "x",
          displayName: "Exec",
        },
      },
    }),
    false,
  );
});

test("run state tracks planConfirmed separately from plan steps", () => {
  const state = createRunState();
  assert.equal(state.planConfirmed, false);
  state.planConfirmed = true;
  assert.equal(state.planConfirmed, true);
});

test("go-ahead is required only when plan has mutation-like obligations", () => {
  assert.equal(planRequiresUserGoAhead([["inspect"]]), false);
  assert.equal(planRequiresUserGoAhead([["validate"]]), false);
  assert.equal(planRequiresUserGoAhead([["modify"]]), true);
  assert.equal(planRequiresUserGoAhead([["execute", "validate"]]), true);
  assert.equal(planRequiresUserGoAhead([["upload"], ["download"]]), true);
  assert.equal(planRequiresUserGoAhead([["connect"]]), true);
});

test("gated tool set covers writes and risky commands but not reads or update_plan", () => {
  for (const tool of [
    "apply_patch",
    "write_file",
    "delete_path",
    "run_command",
    "ssh_run",
    "ssh_write_file",
    "mcp_call_tool",
  ] as const) {
    assert.equal(isPlanConfirmGatedTool(tool), true, tool);
  }
  for (const tool of [
    "read_file",
    "list_directory",
    "search_code",
    "update_plan",
    "git_status",
    "web_search",
  ] as const) {
    assert.equal(isPlanConfirmGatedTool(tool), false, tool);
  }
});

test("instruction is injected only in plan-confirm mode", () => {
  assert.equal(planConfirmInstruction(base), "");
  const text = planConfirmInstruction({
    ...base,
    collaboration: { mode: "plan-confirm" },
  });
  assert.match(text, /计划确认|plan-confirm/);
  assert.match(text, /update_plan/);
  assert.match(text, /confirm/i);
});
