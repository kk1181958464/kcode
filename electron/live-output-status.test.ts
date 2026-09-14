import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseInlineToolActivities,
  deriveLiveGapStatus,
  isInspectTool,
} from "../src/live-output-status";
import type { AgentActivity, AgentToolName } from "../src/types";

function activity(
  id: string,
  tool: AgentToolName,
  status: AgentActivity["status"] = "completed",
  extra: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    requestId: "request",
    tool,
    status,
    title: extra.title ?? id,
    startedAt: 1,
    completedAt: 2,
    input: extra.input ?? {},
    ...extra,
  };
}

test("recognizes inspect tools and similar read-only names", () => {
  assert.equal(isInspectTool("read_file"), true);
  assert.equal(isInspectTool("ssh_read_file"), true);
  assert.equal(isInspectTool("glob_files"), true);
  assert.equal(isInspectTool("search_code"), true);
  assert.equal(isInspectTool("apply_patch"), false);
  assert.equal(isInspectTool("run_command"), false);
});

test("collapses consecutive inspect cards and keeps a count", () => {
  const cards = collapseInlineToolActivities([
    activity("a", "read_file", "completed", { path: "src/a.ts" }),
    activity("b", "list_directory", "completed", { path: "src" }),
    activity("c", "search_code", "running", { input: { query: "gap" } }),
    activity("d", "apply_patch", "completed", { path: "src/a.ts" }),
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.type, "inspect-group");
  if (cards[0]?.type !== "inspect-group") throw new Error("expected group");
  assert.equal(cards[0].count, 3);
  assert.match(cards[0].label, /查看/);
  assert.equal(cards[0].status, "running");
  assert.equal(cards[1]?.type, "item");
});

test("does not collapse a lone inspect card or a broken inspect run", () => {
  const single = collapseInlineToolActivities([
    activity("a", "read_file", "completed", { path: "src/a.ts" }),
    activity("b", "apply_patch", "completed", { path: "src/a.ts" }),
    activity("c", "read_file", "completed", { path: "src/b.ts" }),
  ]);
  assert.deepEqual(
    single.map((card) => card.type),
    ["item", "item", "item"],
  );
});

test("gap status names the active tool instead of a generic wait", () => {
  const gap = deriveLiveGapStatus(
    [activity("read", "read_file", "running", { path: "src/live-output-status.ts" })],
    "",
  );
  assert.equal(gap?.source, "tool");
  assert.match(gap?.label ?? "", /正在读取/);
  assert.match(gap?.label ?? "", /live-output-status/);
});

test("gap status uses classified progress copy while waiting on tokens", () => {
  const gap = deriveLiveGapStatus([], "正在生成回复…");
  assert.equal(gap?.source, "progress");
  assert.equal(gap?.kind, "waiting-model");
  assert.equal(gap?.label, "正在生成回复…");
});

test("gap status explains a token wait after a finished tool", () => {
  const afterTool = deriveLiveGapStatus([
    activity("read", "read_file", "completed", { path: "src/a.ts" }),
  ]);
  assert.equal(afterTool?.source, "token");
  assert.equal(afterTool?.label, "正在根据结果继续…");

  const empty = deriveLiveGapStatus([]);
  assert.equal(empty?.label, "正在生成回复…");
});
