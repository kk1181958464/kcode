import assert from "node:assert/strict";
import test from "node:test";
import { codingEvidenceWithBaseline } from "./agent-finalization";
import {
  compactOperationEvidenceResult,
  type CodingOperation,
} from "./coding-operation-verification";
import type { HistoryItem, ToolCall } from "./agent-types";

function result(
  id: string,
  name: ToolCall["name"],
  success: boolean,
  data: Record<string, unknown>,
): HistoryItem[] {
  return [
    { kind: "calls", calls: [{ id, name, input: {} }], rawCalls: [] },
    compactOperationEvidenceResult(id, name, success, data),
  ];
}

const baseline = new Set<CodingOperation>([
  "inspect",
  "modify",
  "validate",
  "connect",
]);

test("recovered validation expires on a new edit and is restored only by a later check", () => {
  const history: HistoryItem[] = [];
  assert.ok(codingEvidenceWithBaseline(history, baseline).has("validate"));
  history.push(...result("edit-1", "write_file", true, { changed: true }));
  assert.equal(
    codingEvidenceWithBaseline(history, baseline).has("validate"),
    false,
  );
  history.push(
    ...result("check", "run_command", true, {
      executed: true,
      operationEvidence: ["validate"],
    }),
  );
  assert.ok(codingEvidenceWithBaseline(history, baseline).has("validate"));
  history.push(...result("edit-2", "delete_path", true, { changed: true }));
  const evidence = codingEvidenceWithBaseline(history, baseline);
  assert.equal(evidence.has("validate"), false);
  assert.ok(
    evidence.has("connect"),
    "other recovered evidence remains available",
  );
  assert.ok(
    baseline.has("validate"),
    "the baseline itself must remain immutable",
  );
});

test("read-only and unchanged results preserve recovered validation", () => {
  const history = [
    ...result("read", "read_file", true, {}),
    ...result("noop", "write_file", true, { changed: false }),
    ...result("denied", "write_file", false, { executed: false }),
  ];
  assert.ok(codingEvidenceWithBaseline(history, baseline).has("validate"));
});

test("child mutation evidence also invalidates an earlier recovered check", () => {
  const history = result("child", "wait_agent", true, {
    operationEvidence: ["modify"],
  });
  assert.equal(
    codingEvidenceWithBaseline(history, baseline).has("validate"),
    false,
  );
  history.push(
    ...result("checked-child", "wait_agent", true, {
      operationEvidence: ["modify", "validate"],
    }),
  );
  assert.ok(codingEvidenceWithBaseline(history, baseline).has("validate"));
});
