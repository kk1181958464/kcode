import type { AgentActivity } from "./types";

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
    const offset = Number.isFinite(storedOffset)
      ? Math.min(safeLength, Math.max(0, Math.floor(storedOffset)))
      : safeLength;
    const previous = groups.at(-1);
    if (previous?.offset === offset) previous.activities.push(activity);
    else groups.push({ offset, activities: [activity] });
  }
  return groups;
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
