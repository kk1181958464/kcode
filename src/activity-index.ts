import type { AgentActivity } from "./types";

type ActivityIndex = {
  byId: ReadonlyMap<string, number>;
  byRequest: ReadonlyMap<string, AgentActivity[]>;
};

const indexCache = new WeakMap<readonly AgentActivity[], ActivityIndex>();

function buildActivityIndex(
  activities: readonly AgentActivity[],
): ActivityIndex {
  const byId = new Map<string, number>();
  const byRequest = new Map<string, AgentActivity[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    byId.set(activity.id, index);
    const group = byRequest.get(activity.requestId);
    if (group) group.push(activity);
    else byRequest.set(activity.requestId, [activity]);
  }
  return { byId, byRequest };
}

function getActivityIndex(activities: readonly AgentActivity[]): ActivityIndex {
  let index = indexCache.get(activities);
  if (!index) {
    index = buildActivityIndex(activities);
    indexCache.set(activities, index);
  }
  return index;
}

function replaceInRequestGroup(
  index: ActivityIndex,
  previous: AgentActivity,
  next: AgentActivity,
) {
  const byRequest = new Map(index.byRequest);
  const previousGroup = index.byRequest.get(previous.requestId) ?? [];

  if (previous.requestId === next.requestId) {
    const group = previousGroup.slice();
    const position = group.findIndex((activity) => activity.id === previous.id);
    if (position >= 0) group[position] = next;
    byRequest.set(next.requestId, group);
    return byRequest;
  }

  const remaining = previousGroup.filter(
    (activity) => activity.id !== previous.id,
  );
  if (remaining.length) byRequest.set(previous.requestId, remaining);
  else byRequest.delete(previous.requestId);
  byRequest.set(next.requestId, [
    ...(index.byRequest.get(next.requestId) ?? []),
    next,
  ]);
  return byRequest;
}

/**
 * Immutable activity upsert with cached id/request indexes. The resulting
 * array is indexed immediately, so consecutive stream updates do not rescan
 * every previously completed activity just to find one id.
 */
export function upsertActivity(
  activities: readonly AgentActivity[],
  activity: AgentActivity,
): AgentActivity[] {
  const index = getActivityIndex(activities);
  const position = index.byId.get(activity.id);

  if (position === undefined) {
    const next = [...activities, activity];
    const byId = new Map(index.byId);
    byId.set(activity.id, activities.length);
    const byRequest = new Map(index.byRequest);
    byRequest.set(activity.requestId, [
      ...(index.byRequest.get(activity.requestId) ?? []),
      activity,
    ]);
    indexCache.set(next, { byId, byRequest });
    return next;
  }

  if (activities[position] === activity) return activities as AgentActivity[];
  const next = activities.slice();
  const previous = next[position];
  next[position] = activity;
  indexCache.set(next, {
    byId: index.byId,
    byRequest: replaceInRequestGroup(index, previous, activity),
  });
  return next;
}

export function selectActivityGroups(
  activities: readonly AgentActivity[],
  requestIds: Iterable<string>,
): Map<string, AgentActivity[]> {
  const { byRequest } = getActivityIndex(activities);
  const selected = new Map<string, AgentActivity[]>();
  for (const requestId of requestIds) {
    const group = byRequest.get(requestId);
    if (group?.length) selected.set(requestId, group);
  }
  return selected;
}
