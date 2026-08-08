import type { AgentEvent } from "../src/types";
import {
  createRuntimeEventEnvelope,
  type AgentEventEnvelope,
} from "../src/runtime-protocol";

type EventSink = (events: readonly AgentEventEnvelope[]) => void;

const COALESCED_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "text",
  "reasoning",
  "activity_output",
]);

/**
 * Gives every renderer event a stable identity before it crosses IPC. Text is
 * buffered briefly so the journal has the same bounded write cadence as the
 * renderer batcher; structural events flush immediately.
 */
export class RuntimeEventJournal {
  private sequence = 0;
  private pending: AgentEventEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly taskId: string,
    private readonly requestId: string,
    private readonly sink: EventSink,
    private readonly flushDelayMs = 100,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  append(event: AgentEvent, emittedAt = Date.now()) {
    if (this.closed) throw new Error("运行事件账本已关闭");
    const envelope = createRuntimeEventEnvelope(event, {
      taskId: this.taskId,
      requestId: this.requestId,
      sequence: ++this.sequence,
      emittedAt,
    });
    if (!COALESCED_EVENT_TYPES.has(event.type)) {
      this.flush();
      this.pending.push(envelope);
      this.flush();
    } else {
      this.pending.push(envelope);
      if (this.pending.length >= 32) this.flush();
      else this.scheduleFlush();
    }
    return envelope;
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pending.length) return;
    const events = this.pending;
    this.pending = [];
    try {
      this.sink(events);
    } catch (error) {
      // A journal failure must not terminate an otherwise healthy model run.
      // The in-memory IPC stream remains authoritative for this process.
      this.onError(error);
    }
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  get lastSequence() {
    return this.sequence;
  }

  private scheduleFlush() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushDelayMs);
  }
}
