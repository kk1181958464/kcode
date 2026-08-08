export class TurnSteeringQueue {
  private readonly pending = new Map<string, string[]>();

  push(requestId: string, content: string) {
    const value = content.trim();
    if (!requestId || !value) throw new Error("追加指令不能为空");
    const queue = this.pending.get(requestId) ?? [];
    queue.push(value);
    this.pending.set(requestId, queue.slice(-20));
  }

  drain(requestId: string) {
    const queue = this.pending.get(requestId) ?? [];
    this.pending.delete(requestId);
    return queue;
  }

  clear(requestId: string) {
    this.pending.delete(requestId);
  }

  size(requestId: string) {
    return this.pending.get(requestId)?.length ?? 0;
  }
}

export const turnSteeringQueue = new TurnSteeringQueue();
