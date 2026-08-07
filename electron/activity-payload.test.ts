import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_PAYLOAD_STORAGE_THRESHOLD,
  compactTaskActivityPayloads,
  hydrateActivityPayload,
} from "../src/activity-payload";
import type { AgentActivity } from "../src/types";

function activity(output: string): AgentActivity {
  return {
    id: "activity-1",
    requestId: "request-1",
    tool: "run_command",
    status: "success",
    title: "运行命令",
    startedAt: 1,
    completedAt: 2,
    input: {},
    output,
  };
}

test("stores large activity output separately and keeps a bounded preview", () => {
  const output = `HEAD-${"x".repeat(ACTIVITY_PAYLOAD_STORAGE_THRESHOLD)}-TAIL`;
  const result = compactTaskActivityPayloads({
    activities: [activity(output)],
  });
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0].payload.output, output);
  assert.equal(result.task.activities[0].payloadStored, true);
  assert.ok((result.task.activities[0].output?.length ?? 0) < output.length);
  assert.match(result.task.activities[0].output ?? "", /^HEAD-/);
  assert.match(result.task.activities[0].output ?? "", /-TAIL$/);
});

test("hydrates a compact activity without mutating its stored preview", () => {
  const preview = activity("preview");
  preview.payloadStored = true;
  const hydrated = hydrateActivityPayload(preview, { output: "full output" });
  assert.equal(hydrated.output, "full output");
  assert.equal(hydrated.payloadStored, false);
  assert.equal(preview.output, "preview");
});
