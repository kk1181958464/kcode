import assert from "node:assert/strict";
import test from "node:test";
import { selectActivityGroups, upsertActivity } from "../src/activity-index";
import type { AgentActivity } from "../src/types";

function activity(
  id: string,
  requestId = "request-1",
  status: AgentActivity["status"] = "running",
): AgentActivity {
  return {
    id,
    requestId,
    tool: "run_command",
    status,
    title: id,
    startedAt: 1,
    input: {},
  };
}

test("upserts activities without mutating the previous list", () => {
  const first = activity("activity-1");
  const original = [first];
  const completed = { ...first, status: "success" as const };
  const updated = upsertActivity(original, completed);

  assert.notEqual(updated, original);
  assert.equal(original[0], first);
  assert.equal(updated[0], completed);
  assert.equal(upsertActivity(updated, completed), updated);
});

test("keeps request groups current across appends and reassignment", () => {
  let activities = upsertActivity([], activity("activity-1"));
  activities = upsertActivity(
    activities,
    activity("activity-2", "request-2", "success"),
  );
  activities = upsertActivity(
    activities,
    activity("activity-1", "request-2", "success"),
  );

  const groups = selectActivityGroups(activities, [
    "request-1",
    "request-2",
    "missing",
  ]);
  assert.equal(groups.has("request-1"), false);
  assert.deepEqual(
    groups.get("request-2")?.map((item) => item.id),
    ["activity-2", "activity-1"],
  );
  assert.equal(groups.has("missing"), false);
});

test("preserves untouched request group identity", () => {
  let activities = upsertActivity([], activity("activity-1"));
  activities = upsertActivity(
    activities,
    activity("activity-2", "request-2", "running"),
  );
  const before = selectActivityGroups(activities, ["request-1", "request-2"]);

  activities = upsertActivity(
    activities,
    activity("activity-1", "request-1", "success"),
  );
  const after = selectActivityGroups(activities, ["request-1", "request-2"]);

  assert.notEqual(after.get("request-1"), before.get("request-1"));
  assert.equal(after.get("request-2"), before.get("request-2"));
});
