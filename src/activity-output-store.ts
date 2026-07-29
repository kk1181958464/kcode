export type ActivityOutputChange =
  | { type: "append"; value: string }
  | { type: "replace"; value: string }
  | { type: "reset" };

type Listener = (change: ActivityOutputChange) => void;

const values = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();
const MAX_ACTIVITY_OUTPUT_CHARS = 100_000;

function emit(activityId: string, change: ActivityOutputChange) {
  for (const listener of listeners.get(activityId) ?? []) listener(change);
}

export function getActivityOutput(activityId: string) {
  return values.get(activityId) ?? "";
}

export function getActivityOutputTail(activityId: string, maxChars: number) {
  const value = getActivityOutput(activityId);
  return maxChars > 0 && value.length > maxChars ? value.slice(-maxChars) : value;
}

export function appendActivityOutput(activityId: string, value: string) {
  if (!value) return;
  const current = values.get(activityId) ?? "";
  const next = (current + value).slice(-MAX_ACTIVITY_OUTPUT_CHARS);
  values.set(activityId, next);
  emit(
    activityId,
    next.length === current.length + value.length
      ? { type: "append", value }
      : { type: "replace", value: next },
  );
}

export function replaceActivityOutput(activityId: string, value: string) {
  const next = value.slice(-MAX_ACTIVITY_OUTPUT_CHARS);
  if (!next) {
    resetActivityOutput(activityId);
    return;
  }
  values.set(activityId, next);
  emit(activityId, { type: "replace", value: next });
}

export function resetActivityOutput(activityId: string) {
  if (!values.has(activityId)) return;
  values.delete(activityId);
  emit(activityId, { type: "reset" });
}

export function subscribeActivityOutput(
  activityId: string,
  listener: Listener,
) {
  const current = listeners.get(activityId) ?? new Set<Listener>();
  current.add(listener);
  listeners.set(activityId, current);
  return () => {
    current.delete(listener);
    if (!current.size) listeners.delete(activityId);
  };
}
