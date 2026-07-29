export const STREAMING_REASONING_DOM_CHAR_LIMIT = 96_000;
export const STREAMING_REASONING_DOM_TRIM_TARGET = 80_000;

type PositionedActivity = { contentOffset?: number };

export function groupActivitiesByContentOffset<T extends PositionedActivity>(
  activities: readonly T[],
  contentLength: number,
): [number, T[]][] {
  const grouped = new Map<number, T[]>();
  for (const activity of activities) {
    const offset = Math.max(
      0,
      Math.min(contentLength, activity.contentOffset ?? contentLength),
    );
    const group = grouped.get(offset);
    if (group) group.push(activity);
    else grouped.set(offset, [activity]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right);
}

export function boundedStreamingReasoning(value: string): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= STREAMING_REASONING_DOM_CHAR_LIMIT)
    return { text: value, truncated: false };

  let start = value.length - STREAMING_REASONING_DOM_TRIM_TARGET;
  // Preserve a surrogate pair when the trim boundary lands inside an emoji.
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(value[start]) &&
    /[\uD800-\uDBFF]/.test(value[start - 1])
  )
    start -= 1;
  return { text: value.slice(start), truncated: true };
}
