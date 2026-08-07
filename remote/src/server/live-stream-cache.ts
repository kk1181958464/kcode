export type LiveStreamEvent = {
  type: "task.event";
  event: "stream";
  taskId: string;
  requestId: string;
  sequence: number;
  content: string;
  reasoning?: string;
  progress?: string;
  updatedAt: number;
};

export type CachedLiveStreamEvent = LiveStreamEvent & { deviceId: string };

type CacheEntry = {
  userId: string;
  deviceId: string;
  event: LiveStreamEvent;
  receivedAt: number;
};

type TaskState = {
  id: string;
  runningId?: string;
  updatedAt: number;
};

export class LiveStreamCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = 500,
    private readonly maxAgeMs = 12 * 60 * 60 * 1_000,
  ) {}

  private key(userId: string, deviceId: string, taskId: string) {
    return JSON.stringify([userId, deviceId, taskId]);
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries)
      if (now - entry.receivedAt > this.maxAgeMs) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  update(
    userId: string,
    deviceId: string,
    event: LiveStreamEvent,
    receivedAt = Date.now(),
  ): CachedLiveStreamEvent {
    this.prune(receivedAt);
    const key = this.key(userId, deviceId, event.taskId);
    const current = this.entries.get(key);
    if (current) {
      const sameRequest = current.event.requestId === event.requestId;
      const ordered =
        sameRequest && current.event.sequence > 0 && event.sequence > 0;
      const stale = ordered
        ? event.sequence <= current.event.sequence
        : event.updatedAt < current.event.updatedAt;
      if (stale) return { deviceId, ...current.event };
    }
    this.entries.delete(key);
    this.entries.set(key, {
      userId,
      deviceId,
      event: { ...event },
      receivedAt,
    });
    this.prune(receivedAt);
    return { deviceId, ...event };
  }

  list(
    userId: string,
    deviceId?: string,
    now = Date.now(),
  ): CachedLiveStreamEvent[] {
    this.prune(now);
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.userId === userId &&
          (deviceId === undefined || entry.deviceId === deviceId),
      )
      .sort((left, right) => left.event.updatedAt - right.event.updatedAt)
      .map((entry) => ({ deviceId: entry.deviceId, ...entry.event }));
  }

  reconcile(
    userId: string,
    deviceId: string,
    tasks: TaskState[],
    now = Date.now(),
  ) {
    this.prune(now);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    for (const [key, entry] of this.entries) {
      if (entry.userId !== userId || entry.deviceId !== deviceId) continue;
      const task = taskById.get(entry.event.taskId);
      if (!task) {
        this.entries.delete(key);
        continue;
      }
      if (task.runningId === entry.event.requestId) continue;
      if (task.updatedAt >= entry.event.updatedAt) this.entries.delete(key);
    }
  }
}
