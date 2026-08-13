import type { AgentActivity, ChatMessage } from "./types";

export const STREAMING_REASONING_DOM_CHAR_LIMIT = 96_000;
export const STREAMING_REASONING_DOM_TRIM_TARGET = 80_000;

export function visibleAssistantContent(value: string) {
  return value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "");
}

export function shouldShowAssistantTailState(running: boolean) {
  return running;
}

export function truncateAssistantMessageForTextReset(
  message: ChatMessage,
  textOffset: number | undefined,
  streamingText = "",
  replacement = "",
) {
  const parsedOffset = Number(textOffset);
  const retainedOffset = Number.isFinite(parsedOffset)
    ? Math.max(0, Math.floor(parsedOffset))
    : 0;
  const content =
    `${message.content}${streamingText}`.slice(0, retainedOffset) + replacement;
  const parsedFinalOffset = Number(message.finalResponseOffset);
  const clearFinalBoundary =
    Number.isFinite(parsedFinalOffset) && parsedFinalOffset >= retainedOffset;
  if (content === message.content && !clearFinalBoundary) return message;
  if (!clearFinalBoundary) return { ...message, content };
  const {
    finalResponseOffset: _finalResponseOffset,
    finalResponseStartedAt: _finalResponseStartedAt,
    finalResponseProcess: _finalResponseProcess,
    ...rest
  } = message;
  return { ...rest, content };
}

export type AssistantTimelineGroup = {
  offset: number;
  activities: AgentActivity[];
};

export function groupActivitiesByTextOffset(
  activities: AgentActivity[],
  textLength: number,
): AssistantTimelineGroup[] {
  const safeLength = Math.max(0, textLength);
  const groups: AssistantTimelineGroup[] = [];
  for (const activity of activities) {
    const storedOffset = Number(activity.textOffset);
    const clampedOffset = Number.isFinite(storedOffset)
      ? Math.min(safeLength, Math.max(0, Math.floor(storedOffset)))
      : safeLength;
    const previous = groups.at(-1);
    const offset = Math.max(previous?.offset ?? 0, clampedOffset);
    if (previous?.offset === offset) previous.activities.push(activity);
    else groups.push({ offset, activities: [activity] });
  }
  return groups;
}

export function completedProcessTextLength(
  activities: AgentActivity[],
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
  activities: AgentActivity[],
) {
  const activityEnd = activities.reduce(
    (latest, activity) =>
      Math.max(latest, activity.completedAt ?? activity.startedAt),
    createdAt,
  );
  return Math.max(0, (completedAt ?? activityEnd) - createdAt);
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
