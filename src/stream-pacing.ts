const splitAtCodePoint = (text: string, count: number) => {
  if (count <= 0) return ["", text] as const;
  let points = 0;
  let codeUnits = 0;
  for (const point of text) {
    if (points >= count) break;
    points += 1;
    codeUnits += point.length;
  }
  return codeUnits >= text.length
    ? ([text, ""] as const)
    : ([text.slice(0, codeUnits), text.slice(codeUnits)] as const);
};

const codePointLength = (text: string) => {
  let length = 0;
  for (const _point of text) length += 1;
  return length;
};

const releaseBudget = (length: number) =>
  length > 8_192
    ? Math.min(8_192, Math.max(512, Math.ceil(length / 10)))
    : length > 2_048
      ? Math.min(512, Math.max(64, Math.ceil(length / 16)))
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
  private chunks: { text: string; points: number }[] = [];
  private head = 0;
  private bufferedPoints = 0;

  get length() {
    return this.bufferedPoints;
  }

  append(text: string) {
    if (!text) return;
    const points = codePointLength(text);
    const last = this.chunks.at(-1);
    if (last && last.text.length + text.length <= 4_096) {
      last.text += text;
      last.points += points;
    } else this.chunks.push({ text, points });
    this.bufferedPoints += points;
  }

  take(drainAll = false, releaseSingleton = false) {
    const length = this.length;
    if (!length || (!drainAll && length < 2 && !releaseSingleton)) return "";
    const budget = drainAll ? length : releaseBudget(length);
    let remaining = budget;
    const output: string[] = [];
    while (remaining > 0 && this.head < this.chunks.length) {
      const chunk = this.chunks[this.head];
      if (chunk.points <= remaining) {
        output.push(chunk.text);
        remaining -= chunk.points;
        this.bufferedPoints -= chunk.points;
        this.head += 1;
      } else {
        const [slice, rest] = splitAtCodePoint(chunk.text, remaining);
        output.push(slice);
        chunk.text = rest;
        chunk.points -= remaining;
        this.bufferedPoints -= remaining;
        remaining = 0;
      }
    }
    this.compact();
    return output.join("");
  }

  private compact() {
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
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

  const length = codePointLength(buffered);
  if (length < 2 && !releaseSingleton)
    return { slice: "", remaining: buffered };
  // Stable two-character ticks look smooth for normal Chinese output. Increase
  // the budget only when a backlog would otherwise make the UI fall behind.
  const budget = releaseBudget(length);
  const [slice, remaining] = splitAtCodePoint(buffered, budget);
  return { slice, remaining };
}

// A 32 ms cadence stays visually fluid without forcing the renderer to paint
// every display frame. The live view only appends text nodes at this cadence;
// Markdown is rendered once the current segment settles.
export const STREAM_PACING_INTERVAL_MS = 32;
export const STREAM_SINGLETON_MAX_HOLD_MS = STREAM_PACING_INTERVAL_MS;
// Streaming paint/layout yields briefly after a composer input event. This is
// long enough to protect an IME key burst while remaining visually immediate.
export const COMPOSER_STREAM_PAUSE_MS = 120;
