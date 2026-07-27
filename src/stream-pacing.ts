const splitAtCodePoint = (text: string, count: number) => {
  if (count <= 0) return ["", text] as const;
  const points = Array.from(text);
  if (points.length <= count) return [text, ""] as const;
  return [points.slice(0, count).join(""), points.slice(count).join("")] as const;
};

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
  const budget = length > 160 ? 8 : length > 64 ? 4 : 2;
  const [slice, remaining] = splitAtCodePoint(buffered, budget);
  return { slice, remaining };
}

export const STREAM_PACING_INTERVAL_MS = 50;