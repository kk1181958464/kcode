import type { AgentActivity, AgentEvent } from "../src/types";

export const approvals = new Map<string, (allowed: boolean) => void>();

/** Register before publishing the prompt and clean up every way of settling. */
export async function* waitForAgentApproval(
  requestId: string,
  activity: AgentActivity,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, boolean> {
  const key = `${requestId}:${activity.id}`;
  let dispose = () => {};
  const pending = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (approvals.get(key) === finish) approvals.delete(key);
      resolve(allowed);
    };
    const onAbort = () => finish(false);
    dispose = onAbort;
    if (signal.aborted) {
      finish(false);
      return;
    }
    approvals.set(key, finish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    if (!signal.aborted) yield { type: "activity", activity };
    return (await pending) && !signal.aborted;
  } finally {
    dispose();
  }
}
