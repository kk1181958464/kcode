import type { AgentEvent } from "../src/types";

export const RENDERER_EVENT_BATCH_MS = 32;

/**
 * Coalesces high-frequency model deltas before crossing Electron's IPC
 * boundary. Structural events flush immediately and therefore retain their
 * ordering relative to streamed text.
 */
export class RendererEventBatcher {
  private pending: AgentEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly send: (event: AgentEvent) => void) {}

  push(event: AgentEvent) {
    if (this.closed) return;
    if (
      event.type !== "text" &&
      event.type !== "reasoning" &&
      event.type !== "activity_output"
    ) {
      this.flush();
      this.send(event);
      return;
    }

    const previous = this.pending.at(-1);
    if (event.type === "text" && previous?.type === "text")
      previous.delta += event.delta;
    else if (event.type === "reasoning" && previous?.type === "reasoning")
      previous.delta += event.delta;
    else if (
      event.type === "activity_output" &&
      previous?.type === "activity_output" &&
      previous.activityId === event.activityId
    ) {
      if (event.mode === "replace") {
        previous.mode = "replace";
        previous.value = event.value;
      } else previous.value += event.value;
    } else this.pending.push({ ...event });

    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, RENDERER_EVENT_BATCH_MS);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pending.length) return;
    const events = this.pending;
    this.pending = [];
    for (const event of events) this.send(event);
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }
}
