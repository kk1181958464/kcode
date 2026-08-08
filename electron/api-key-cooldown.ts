const DEFAULT_COOLDOWN_MS = 90_000;

function slot(providerId: string, index: number) {
  return `${providerId}:${index}`;
}

export class ApiKeyCooldownPool {
  private readonly unavailableUntil = new Map<string, number>();

  constructor(private readonly cooldownMs = DEFAULT_COOLDOWN_MS) {}

  select(providerId: string, keyCount: number, now = Date.now()) {
    if (keyCount <= 1) return 0;
    let earliestIndex = 0;
    let earliestTime = Number.POSITIVE_INFINITY;
    for (let index = 0; index < keyCount; index += 1) {
      const key = slot(providerId, index);
      const until = this.unavailableUntil.get(key) ?? 0;
      if (until <= now) {
        this.unavailableUntil.delete(key);
        return index;
      }
      if (until < earliestTime) {
        earliestTime = until;
        earliestIndex = index;
      }
    }
    return earliestIndex;
  }

  /**
   * Pick an untried key for the current request. Healthy keys win over keys
   * that are still cooling down; the latter are only used when every key is
   * unavailable so a request can still make progress after a full outage.
   */
  next(
    providerId: string,
    keyCount: number,
    currentIndex: number,
    tried: ReadonlySet<number>,
    now = Date.now(),
  ) {
    if (keyCount <= 1) return undefined;
    let earliestIndex: number | undefined;
    let earliestTime = Number.POSITIVE_INFINITY;
    for (let offset = 1; offset <= keyCount; offset += 1) {
      const index = (currentIndex + offset) % keyCount;
      if (tried.has(index)) continue;
      const key = slot(providerId, index);
      const until = this.unavailableUntil.get(key) ?? 0;
      if (until <= now) {
        this.unavailableUntil.delete(key);
        return index;
      }
      if (until < earliestTime) {
        earliestTime = until;
        earliestIndex = index;
      }
    }
    return earliestIndex;
  }

  markUnavailable(providerId: string, index: number, now = Date.now()) {
    this.unavailableUntil.set(slot(providerId, index), now + this.cooldownMs);
  }

  markHealthy(providerId: string, index: number) {
    this.unavailableUntil.delete(slot(providerId, index));
  }
}

export const apiKeyCooldownPool = new ApiKeyCooldownPool();
