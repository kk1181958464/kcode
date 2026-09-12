import type { AgentEvent } from "../src/types";
import {
  reduceRuntimeState,
  initialRuntimeState,
  type RuntimeState,
} from "../src/runtime-state-machine";
import type { RuntimeTaskStatusSnapshot } from "../src/runtime-protocol";

export type RuntimeRunSnapshot = RuntimeState & {
  taskId: string;
  active: boolean;
};

/** Main-process runtime registry shared by desktop, remote, and diagnostics. */
export class AgentRuntimeService {
  private readonly runs = new Map<
    string,
    { taskId: string; state: RuntimeState; active: boolean }
  >();

  start(taskId: string, requestId: string, startedAt = Date.now()) {
    const state = initialRuntimeState(requestId, startedAt);
    this.runs.set(requestId, { taskId, state, active: true });
    this.prune();
    return state;
  }

  /** Restore the latest durable projection after the main process starts. */
  restore(snapshots: readonly RuntimeTaskStatusSnapshot[]) {
    for (const snapshot of snapshots) {
      const active =
        snapshot.status === "running" || snapshot.status === "waiting";
      this.runs.set(snapshot.requestId, {
        taskId: snapshot.taskId,
        active,
        state: {
          requestId: snapshot.requestId,
          threadStatus: snapshot.status,
          turnStatus: snapshot.turnStatus,
          lastSequence: snapshot.lastSequence,
          startedAt: snapshot.updatedAt,
          updatedAt: snapshot.updatedAt,
        },
      });
    }
    this.prune();
  }

  apply(taskId: string, requestId: string, event: AgentEvent) {
    const current = this.runs.get(requestId);
    const state = current?.state ?? initialRuntimeState(requestId);
    const next = reduceRuntimeState(
      state,
      event,
      event.sequence ?? state.lastSequence + 1,
      event.emittedAt,
    );
    // The reducer is authoritative: stale events return the exact same state
    // object and must not resurrect a terminal run.
    if (next === state) return next;
    this.runs.set(requestId, {
      taskId,
      state: next,
      active: next.threadStatus === "running" || next.threadStatus === "waiting",
    });
    this.prune();
    return next;
  }

  markInactive(requestId: string) {
    const current = this.runs.get(requestId);
    if (current) this.runs.set(requestId, { ...current, active: false });
  }

  list(taskId?: string) {
    return [...this.runs.entries()]
      .filter(([, run]) => !taskId || run.taskId === taskId)
      .map(([requestId, run]) => ({
        ...run.state,
        requestId,
        taskId: run.taskId,
        active: run.active,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  active(taskId?: string) {
    return this.list(taskId).filter((run) => run.active);
  }

  clear(requestId: string) {
    this.runs.delete(requestId);
  }

  reset() {
    this.runs.clear();
  }

  private prune(maxRuns = 200) {
    if (this.runs.size <= maxRuns) return;
    const removable = [...this.runs.entries()]
      .filter(([, run]) => !run.active)
      .sort(
        (left, right) => left[1].state.updatedAt - right[1].state.updatedAt,
      );
    for (const [requestId] of removable) {
      if (this.runs.size <= maxRuns) break;
      this.runs.delete(requestId);
    }
  }
}

export const agentRuntimeService = new AgentRuntimeService();
