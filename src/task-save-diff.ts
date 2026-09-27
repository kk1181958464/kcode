import type { SaveTaskOptions } from "./types";

type Identified = { id: string };
type TaskItems = { messages?: Identified[]; activities?: Identified[] };

function changedIds(
  previous: readonly Identified[] | undefined,
  next: readonly Identified[] | undefined,
) {
  const before = new Map((previous ?? []).map((item) => [item.id, item]));
  const ids: string[] = [];
  for (const item of next ?? [])
    if (before.get(item.id) !== item) ids.push(item.id);
  return ids;
}

/**
 * Items are updated immutably, so an item whose object identity matches the
 * last persisted task is unchanged and the main process can skip rewriting it.
 * Without a persisted baseline the whole task is written.
 */
export function taskSaveDiff(
  persisted: TaskItems | undefined,
  next: TaskItems,
): Pick<SaveTaskOptions, "changedMessageIds" | "changedActivityIds"> {
  if (!persisted) return {};
  return {
    changedMessageIds: changedIds(persisted.messages, next.messages),
    changedActivityIds: changedIds(persisted.activities, next.activities),
  };
}
