export const MOBILE_MESSAGE_BATCH = 36;
export const MOBILE_TASK_BATCH = 60;
export const MOBILE_LIVE_TEXT_LIMIT = 24_000;

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
