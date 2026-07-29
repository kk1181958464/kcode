const splitAtCodePoint = (text: string, count: number) => {
  if (count <= 0) return ["", text] as const;
  const points = Array.from(text);
  if (points.length <= count) return [text, ""] as const;
  return [
    points.slice(0, count).join(""),
    points.slice(count).join(""),
  ] as const;
};

const releaseBudget = (length: number) =>
  length > 2_048
    ? 64
    : length > 512
      ? 24
      : length > 160
        ? 8
        : length > 64
          ? 4
          : 2;

/**
 * Incremental Unicode queue used by the live stream path. Appending only scans
 * the new delta and taking a slice only touches the characters being released,
 * so a large upstream backlog does not get re-scanned every 50 ms.
 */
export class StreamPacingBuffer {
  private points: string[] = [];
  private offset = 0;

  get length() {
    return this.points.length - this.offset;
  }

  append(text: string) {
    for (const point of text) this.points.push(point);
  }

  take(drainAll = false, releaseSingleton = false) {
    const length = this.length;
    if (!length || (!drainAll && length < 2 && !releaseSingleton)) return "";
    const budget = drainAll ? length : releaseBudget(length);
    const end = Math.min(this.points.length, this.offset + budget);
    const slice = this.points.slice(this.offset, end).join("");
    this.offset = end;
    this.compact();
    return slice;
  }

  private compact() {
    if (this.offset === this.points.length) {
      this.points = [];
      this.offset = 0;
    } else if (this.offset >= 1_024 && this.offset * 2 >= this.points.length) {
      this.points = this.points.slice(this.offset);
      this.offset = 0;
    }
  }
}

export function takeStreamPacedSlice(
  buffered: string,
  drainAll = false,
  releaseSingleton = false,
) {
  if (!buffered) return { slice: "", remaining: "" };
  if (drainAll) return { slice: buffered, remaining: "" };

  const length = Array.from(buffered).length;
  if (length < 2 && !releaseSingleton)
    return { slice: "", remaining: buffered };
  // Stable two-character ticks look smooth for normal Chinese output. Increase
  // the budget only when a backlog would otherwise make the UI fall behind.
  const budget = releaseBudget(length);
  const [slice, remaining] = splitAtCodePoint(buffered, budget);
  return { slice, remaining };
}

export const STREAM_PACING_INTERVAL_MS = 50;
// Streaming paint/layout yields briefly after a composer input event. This is
// long enough to protect an IME key burst while remaining visually immediate.
export const COMPOSER_STREAM_PAUSE_MS = 120;
