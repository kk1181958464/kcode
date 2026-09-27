export class TurnSteeringQueue {
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, string[]>();
  private readonly listeners = new Map<string, Set<() => void>>();

  open(requestId: string) {
    this.active.add(requestId);
  }

  push(requestId: string, content: string) {
    const value = content.trim();
    if (!requestId || !value) throw new Error("追加指令不能为空");
    if (!this.active.has(requestId))
      throw new Error("任务已结束，请发送新消息继续");
    const queue = this.pending.get(requestId) ?? [];
    queue.push(value);
    this.pending.set(requestId, queue.slice(-20));
    for (const listener of this.listeners.get(requestId) ?? []) listener();
  }

  drain(requestId: string) {
    const queue = this.pending.get(requestId) ?? [];
    this.pending.delete(requestId);
    return queue;
  }

  clear(requestId: string) {
    this.active.delete(requestId);
    this.pending.delete(requestId);
  }

  size(requestId: string) {
    return this.pending.get(requestId)?.length ?? 0;
  }

  subscribe(requestId: string, listener: () => void) {
    const listeners = this.listeners.get(requestId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(requestId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(requestId);
    };
  }
}

export const turnSteeringQueue = new TurnSteeringQueue();
