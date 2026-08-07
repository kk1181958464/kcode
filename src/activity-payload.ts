import type { AgentActivity, AgentFileChange } from "./types";

export const ACTIVITY_PAYLOAD_STORAGE_THRESHOLD = 24_000;
const ACTIVITY_PAYLOAD_PREVIEW_CHARS = 12_000;

export type ActivityPayload = {
  output?: string;
  diff?: string;
  fileChanges?: AgentFileChange[];
};

export type DeferredActivityPayload = {
  activityId: string;
  payload: ActivityPayload;
};

function payloadPreview(text: string) {
  if (text.length <= ACTIVITY_PAYLOAD_PREVIEW_CHARS) return text;
  const marker = "\n\n... [完整内容将在展开时加载] ...\n\n";
  const available = ACTIVITY_PAYLOAD_PREVIEW_CHARS - marker.length;
  const head = Math.floor(available * 0.45);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function compactActivity(activity: AgentActivity): {
  activity: AgentActivity;
  deferred?: DeferredActivityPayload;
} {
  const payload: ActivityPayload = {};
  let compacted = activity;
  if (
    typeof activity.output === "string" &&
    activity.output.length > ACTIVITY_PAYLOAD_STORAGE_THRESHOLD
  ) {
    payload.output = activity.output;
    compacted = { ...compacted, output: payloadPreview(activity.output) };
  }
  if (
    typeof activity.diff === "string" &&
    activity.diff.length > ACTIVITY_PAYLOAD_STORAGE_THRESHOLD
  ) {
    payload.diff = activity.diff;
    compacted = { ...compacted, diff: payloadPreview(activity.diff) };
  }
  if (
    activity.fileChanges?.some(
      (change) =>
        typeof change.diff === "string" &&
        change.diff.length > ACTIVITY_PAYLOAD_STORAGE_THRESHOLD,
    )
  ) {
    payload.fileChanges = activity.fileChanges;
    compacted = {
      ...compacted,
      fileChanges: activity.fileChanges.map((change) => ({
        ...change,
        diff: change.diff ? payloadPreview(change.diff) : change.diff,
      })),
    };
  }
  if (!Object.keys(payload).length) return { activity: compacted };
  return {
    activity: { ...compacted, payloadStored: true },
    deferred: { activityId: activity.id, payload },
  };
}

export function compactTaskActivityPayloads<T>(value: T): {
  task: T;
  payloads: DeferredActivityPayload[];
} {
  if (!value || typeof value !== "object") return { task: value, payloads: [] };
  const task = value as T & { activities?: AgentActivity[] };
  if (!Array.isArray(task.activities)) return { task: value, payloads: [] };
  const payloads: DeferredActivityPayload[] = [];
  const activities = task.activities.map((activity) => {
    const result = compactActivity(activity);
    if (result.deferred) payloads.push(result.deferred);
    return result.activity;
  });
  return { task: { ...task, activities } as T, payloads };
}

export function hydrateActivityPayload(
  activity: AgentActivity,
  payload?: ActivityPayload | null,
) {
  if (!payload) return activity;
  return {
    ...activity,
    ...payload,
    payloadStored: false,
  };
}
