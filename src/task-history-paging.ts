import type { TaskItemPage, TaskItemPageMetadata } from "./types";
import type { ConversationWindow } from "./conversation-window";

export const TASK_MESSAGE_PAGE_SIZE = 40;

export function prependUniqueItems<T extends { id: string }>(
  older: readonly T[],
  current: readonly T[],
) {
  const currentIds = new Set(current.map((item) => item.id));
  return [...older.filter((item) => !currentIds.has(item.id)), ...current];
}

export function prependPageMetadata<T>(
  current: TaskItemPageMetadata,
  page: TaskItemPage<T>,
): TaskItemPageMetadata {
  return {
    oldestCursor: page.oldestCursor ?? current.oldestCursor,
    newestCursor: current.newestCursor ?? page.newestCursor,
    hasMoreBefore: page.hasMoreBefore,
    // A backward page reports newer rows because the already-loaded window is
    // newer. They are not missing from the aggregate window.
    hasMoreAfter: current.hasMoreAfter,
  };
}

export function completePageMetadata(items: readonly { id: string }[]) {
  return {
    oldestCursor: items[0]?.id,
    newestCursor: items.at(-1)?.id,
    hasMoreBefore: false,
    hasMoreAfter: false,
  } satisfies TaskItemPageMetadata;
}

export function windowAfterPrepend(
  current: ConversationWindow,
  prependedTurns: number,
  totalTurns: number,
  pageSize: number,
): ConversationWindow {
  const size = Math.max(1, pageSize);
  const anchorIndex = Math.max(0, prependedTurns);
  return {
    start: Math.max(0, anchorIndex - size),
    end: Math.min(
      totalTurns,
      Math.max(anchorIndex + 1, anchorIndex + current.end),
    ),
  };
}
