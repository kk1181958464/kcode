import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantRequestId,
  buildInterruptedRunRecoveryContext,
} from "../src/interrupted-run-context";
import type { AgentActivity, ChatMessage } from "../src/types";

const activity = (
  requestId: string,
  overrides: Partial<AgentActivity> = {},
): AgentActivity => ({
  id: crypto.randomUUID(),
  requestId,
  tool: "run_command",
  status: "success",
  title: "运行检查",
  startedAt: 1,
  input: {},
  command: "php -l index.php",
  output: "No syntax errors detected",
  ...overrides,
});

test("extracts the runtime request id from an assistant message", () => {
  const message: ChatMessage = {
    id: "assistant:req-42",
    role: "assistant",
    content: "partial",
    createdAt: 1,
  };
  assert.equal(assistantRequestId(message), "req-42");
});

test("restores only the interrupted request evidence and redacts secrets", () => {
  const context = buildInterruptedRunRecoveryContext(
    [
      activity("old", { output: "ignore me" }),
      activity("req-1", {
        path: "src/index.php",
        additions: 3,
        deletions: 1,
        output: "password=plain-secret\nvalidation passed",
      }),
      activity("req-1", {
        status: "failed",
        title: "启动服务",
        errorSummary: "端口已占用",
      }),
    ],
    "req-1",
  );
  assert.ok(context);
  assert.match(context, /src\/index\.php/);
  assert.match(context, /\+3 -1/);
  assert.match(context, /端口已占用/);
  assert.doesNotMatch(context, /plain-secret/);
  assert.doesNotMatch(context, /ignore me/);
});

test("does not invent recovery evidence when no activity was persisted", () => {
  assert.equal(buildInterruptedRunRecoveryContext([], "missing"), undefined);
});
