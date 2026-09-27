import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { AgentActivity } from "../src/types";
import { approvals, waitForAgentApproval } from "./agent-approval";

function activity(id = "approval"): AgentActivity {
  return {
    id,
    requestId: "approval-test",
    tool: "write_file",
    status: "waiting",
    title: "写入文件",
    startedAt: Date.now(),
    input: {},
  };
}

for (const allowed of [true, false]) {
  test(`immediate ${allowed ? "approval" : "denial"} settles and removes the abort listener`, async () => {
    const controller = new AbortController();
    // Reuse one signal, as a real task does across repeated approvals.
    for (let i = 0; i < 25; i++) {
      const prompt = activity(String(i));
      const key = `${prompt.requestId}:${prompt.id}`;
      const wait = waitForAgentApproval(
        prompt.requestId,
        prompt,
        controller.signal,
      );
      assert.equal((await wait.next()).done, false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      const resolve = approvals.get(key);
      assert.ok(
        resolve,
        "resolver must exist when waiting event becomes visible",
      );
      resolve(allowed);
      assert.deepEqual(await wait.next(), { done: true, value: allowed });
      assert.equal(approvals.has(key), false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  });
}

test("already aborted approval never publishes a waiting prompt", async () => {
  const controller = new AbortController();
  controller.abort();
  const prompt = activity();
  const wait = waitForAgentApproval(
    prompt.requestId,
    prompt,
    controller.signal,
  );
  assert.deepEqual(await wait.next(), { done: true, value: false });
  assert.equal(approvals.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const timing of ["prompt", "pending", "approved", "closed"] as const) {
  test(`approval cleans up when cancelled at ${timing}`, async () => {
    const controller = new AbortController();
    const prompt = activity(timing);
    const key = `${prompt.requestId}:${prompt.id}`;
    const wait = waitForAgentApproval(
      prompt.requestId,
      prompt,
      controller.signal,
    );
    await wait.next();
    if (timing === "closed") {
      await wait.return(false);
    } else {
      if (timing === "approved") approvals.get(key)!(true);
      const pending = timing === "pending" ? wait.next() : undefined;
      controller.abort();
      assert.deepEqual(await (pending ?? wait.next()), {
        done: true,
        value: false,
      });
    }
    assert.equal(approvals.has(key), false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}
