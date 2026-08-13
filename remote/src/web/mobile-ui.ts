export const MOBILE_MESSAGE_BATCH = 36;
export const MOBILE_TASK_BATCH = 60;
export const MOBILE_LIVE_TEXT_LIMIT = 24_000;

export type LiveStreamOrder = {
  requestId: string;
  sequence?: number;
  runtimeEventId?: string;
  runtimeSequence?: number;
  updatedAt: number;
};

/** Prefer the canonical runtime journal order when a stream carries it. */
export function newerLiveStream<T extends LiveStreamOrder>(
  current: T | undefined,
  next: T,
) {
  if (!current) return true;
  if (
    current.requestId === next.requestId &&
    current.runtimeEventId &&
    next.runtimeEventId &&
    current.runtimeEventId === next.runtimeEventId
  )
    return false;
  if (
    current.requestId === next.requestId &&
    current.runtimeSequence !== undefined &&
    next.runtimeSequence !== undefined
  )
    return next.runtimeSequence > current.runtimeSequence;
  if (
    current.requestId === next.requestId &&
    current.sequence !== undefined &&
    next.sequence !== undefined
  )
    return next.sequence > current.sequence;
  return next.updatedAt >= current.updatedAt;
}

type ProcessActivity = {
  textOffset?: number;
  subagentId?: string;
  startedAt: number;
  completedAt?: number;
};

export function shouldShowCompletedProcess(input: {
  role: "user" | "assistant";
  activityCount: number;
  running: boolean;
  finalResponseOffset?: number;
  finalResponseProcess?: "correction";
}) {
  if (input.role !== "assistant") return false;
  const offset = Number(input.finalResponseOffset);
  const hasCorrectionProcess =
    input.finalResponseProcess === "correction" &&
    Number.isFinite(offset) &&
    offset > 0;
  return (
    hasCorrectionProcess ||
    (input.activityCount > 0 &&
      (!input.running || Number.isFinite(input.finalResponseOffset)))
  );
}

export function visibleMessageWindow<T>(items: T[], visibleCount: number) {
  const count = Math.max(1, Math.floor(visibleCount));
  const start = Math.max(0, items.length - count);
  return {
    hiddenCount: start,
    items: items.slice(start),
  };
}

function suffixPrefixOverlap(left: string, right: string, limit = 4_096) {
  const size = Math.min(left.length, right.length, limit);
  if (size < 4) return 0;
  const pattern = right.slice(0, size);
  const source = `${pattern}\0${left.slice(-size)}`;
  const prefix = new Uint32Array(source.length);
  for (let index = 1; index < source.length; index += 1) {
    let length = prefix[index - 1];
    while (length && source[index] !== source[length])
      length = prefix[length - 1];
    if (source[index] === source[length]) length += 1;
    prefix[index] = length;
  }
  return Math.min(size, prefix.at(-1) || 0);
}

export function mergeLiveContent(content: string, liveContent = "") {
  if (!liveContent || content.endsWith(liveContent)) return content;
  if (!content || liveContent.startsWith(content)) return liveContent;
  const overlap = suffixPrefixOverlap(content, liveContent);
  return content + liveContent.slice(overlap >= 4 ? overlap : 0);
}

export function boundedLiveText(value: string, limit = MOBILE_LIVE_TEXT_LIMIT) {
  if (value.length <= limit) return { text: value, truncated: false };
  let start = value.length - limit;
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(value[start]) &&
    /[\uD800-\uDBFF]/.test(value[start - 1])
  )
    start -= 1;
  return { text: value.slice(start), truncated: true };
}

export function completedProcessTextLength(
  activities: ProcessActivity[],
  textLength: number,
) {
  const safeLength = Math.max(0, textLength);
  const rootOffsets = activities
    .filter((activity) => !activity.subagentId)
    .map((activity) => Number(activity.textOffset))
    .filter(Number.isFinite)
    .map((offset) => Math.min(safeLength, Math.max(0, Math.floor(offset))));
  return rootOffsets.length ? Math.max(...rootOffsets) : 0;
}

export function completedProcessDuration(
  createdAt: number,
  completedAt: number | undefined,
  activities: ProcessActivity[],
) {
  const activityEnd = activities.reduce(
    (latest, activity) =>
      Math.max(latest, activity.completedAt ?? activity.startedAt),
    createdAt,
  );
  return Math.max(0, (completedAt ?? activityEnd) - createdAt);
}

export function formatCompactDuration(milliseconds: number) {
  if (milliseconds < 1000) return "<1s";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function reconcileById<T extends { id: string }>(
  previous: T[],
  next: T[],
  equals: (left: T, right: T) => boolean,
) {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  let changed = previous.length !== next.length;
  const reconciled = next.map((item, index) => {
    const existing = previousById.get(item.id);
    const value = existing && equals(existing, item) ? existing : item;
    if (value !== previous[index]) changed = true;
    return value;
  });
  return changed ? reconciled : previous;
}
