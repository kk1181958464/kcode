import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentActivity,
  AgentEvent,
  PermissionMode,
  PermissionPolicy,
  SubagentCheckpoint,
} from "../src/types";

const MAX_ACTIVE_SUBAGENTS_PER_ROOT = 8;
const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_RETAINED_TRANSCRIPT_CHARS = 2_000;
const MAX_RESULT_ACTIVITIES = 25;
const STOP_GRACE_MS = 10_000;

export type SubagentStatus =
  "running" | "stopping" | "completed" | "failed" | "stopped";

type SubagentRecord = {
  id: string;
  requestId: string;
  parentRequestId: string;
  rootRequestId: string;
  name: string;
  task: string;
  status: SubagentStatus;
  acceptingInstructions: boolean;
  startedAt: number;
  completedAt?: number;
  controller: AbortController;
  promise: Promise<void>;
  transcript: string;
  error?: string;
  usage: { input: number; output: number; cached: number };
  usageReported: boolean;
  activities: Map<string, AgentActivity>;
  instructions: string[];
};

export type SubagentRunner = (
  requestId: string,
  agentId: string,
  signal: AbortSignal,
) => AsyncGenerator<AgentEvent>;

const agents = new Map<string, SubagentRecord>();
const messageQueues = new Map<string, string[]>();
const descendantRequestIds = new Map<string, Set<string>>();
const mutationOwners = new Map<string, Map<string, string>>();
const eventSinks = new Map<string, (event: AgentEvent) => void>();

function directChildren(parentRequestId: string) {
  return [...agents.values()].filter(
    (agent) => agent.parentRequestId === parentRequestId,
  );
}

function recordByRequestId(requestId: string) {
  return [...agents.values()].find((agent) => agent.requestId === requestId);
}

function redactSensitiveText(value: string) {
  return value
    .replace(
      /((?:password|passwd|passphrase|密码|口令|密钥)\s*(?:是|为|[:=])?\s*)\S+/gi,
      "$1[已隐藏]",
    )
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/g, "[已隐藏密钥]")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[已隐藏私钥]",
    );
}

function publicState(agent: SubagentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    task: "任务详情已隐藏",
    status: agent.status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    usage: { ...agent.usage },
    collected: agent.usageReported,
    error: agent.error,
  };
}

function resultState(agent: SubagentRecord) {
  const activityRecords = [...agent.activities.values()].map((activity) => ({
    ...activity,
    title: `${agent.name} · ${activity.title}`,
    subagentId: agent.id,
    subagentName: agent.name,
  }));
  const activities = activityRecords
    .slice(-MAX_RESULT_ACTIVITIES)
    .map((activity) => ({
      title: activity.title,
      tool: activity.tool,
      status: activity.status,
      path: activity.path,
      command: activity.command,
      output: activity.output?.slice(-500),
      additions: activity.additions,
      deletions: activity.deletions,
    }));
  return {
    ...publicState(agent),
    transcript: agent.transcript.slice(-MAX_TRANSCRIPT_CHARS),
    instructions: agent.instructions.map(() => "追加指令已隐藏"),
    activities,
    activityRecords,
  };
}

function compactCollectedRecord(agent: SubagentRecord) {
  agent.transcript = agent.transcript.slice(-MAX_RETAINED_TRANSCRIPT_CHARS);
  agent.activities.clear();
  agent.instructions = agent.instructions.slice(-5).map(redactSensitiveText);
  agent.task = redactSensitiveText(agent.task);
}

function rememberDescendant(parentRequestId: string, requestId: string) {
  let current: string | undefined = parentRequestId;
  while (current) {
    const children = descendantRequestIds.get(current) ?? new Set<string>();
    children.add(requestId);
    descendantRequestIds.set(current, children);
    current = recordByRequestId(current)?.parentRequestId;
  }
}

export function permissionPolicyForSubagent(
  _mode: PermissionMode,
  policy?: PermissionPolicy,
) {
  return policy;
}

export function setSubagentEventSink(
  rootRequestId: string,
  sink: (event: AgentEvent) => void,
) {
  eventSinks.set(rootRequestId, sink);
  return () => eventSinks.delete(rootRequestId);
}

export function spawnSubagent(
  parentRequestId: string,
  name: string,
  task: string,
  parentSignal: AbortSignal,
  runner: SubagentRunner,
) {
  const parent = recordByRequestId(parentRequestId);
  const rootRequestId = parent?.rootRequestId ?? parentRequestId;
  const active = [...agents.values()].filter(
    (agent) =>
      agent.rootRequestId === rootRequestId &&
      (agent.status === "running" || agent.status === "stopping"),
  ).length;
  if (active >= MAX_ACTIVE_SUBAGENTS_PER_ROOT)
    throw new Error(
      `当前任务已有 ${MAX_ACTIVE_SUBAGENTS_PER_ROOT} 个子 Agent 在运行，请先等待或停止部分任务。`,
    );
  const id = randomUUID();
  const requestId = `subagent:${id}`;
  const controller = new AbortController();
  const record: SubagentRecord = {
    id,
    requestId,
    parentRequestId,
    rootRequestId,
    name:
      name.trim() || `子 Agent ${directChildren(parentRequestId).length + 1}`,
    task,
    status: "running",
    acceptingInstructions: true,
    startedAt: Date.now(),
    controller,
    promise: Promise.resolve(),
    transcript: "",
    usage: { input: 0, output: 0, cached: 0 },
    usageReported: false,
    activities: new Map(),
    instructions: [],
  };
  messageQueues.set(requestId, []);
  agents.set(id, record);
  rememberDescendant(parentRequestId, requestId);
  const stopWithParent = () => {
    record.acceptingInstructions = false;
    if (record.status === "running") record.status = "stopping";
    controller.abort();
  };
  parentSignal.addEventListener("abort", stopWithParent, { once: true });
  record.promise = (async () => {
    try {
      for await (const event of runner(requestId, id, controller.signal)) {
        if (event.type === "text")
          record.transcript = (record.transcript + event.delta).slice(
            -MAX_TRANSCRIPT_CHARS,
          );
        else if (event.type === "usage")
          record.usage = {
            input: event.input,
            output: event.output,
            cached: event.cached ?? 0,
          };
        else if (event.type === "activity") {
          record.activities.set(event.activity.id, event.activity);
          eventSinks.get(record.rootRequestId)?.({
            type: "activity",
            activity: {
              ...event.activity,
              requestId: record.rootRequestId,
              title: `${record.name} · ${event.activity.title}`,
              subagentId: record.id,
              subagentName: record.name,
            },
          });
        } else if (event.type === "error") throw new Error(event.message);
      }
      record.status = controller.signal.aborted ? "stopped" : "completed";
    } catch (error) {
      record.status = controller.signal.aborted ? "stopped" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      record.acceptingInstructions = false;
      parentSignal.removeEventListener("abort", stopWithParent);
      record.completedAt = Date.now();
      messageQueues.delete(requestId);
      await stopSubagentsForParent(requestId, false);
    }
  })();
  return publicState(record);
}

export function listSubagents(parentRequestId: string) {
  return directChildren(parentRequestId).map(publicState);
}

export function closeSubagentMessageQueue(requestId: string) {
  const agent = recordByRequestId(requestId);
  if (agent) agent.acceptingInstructions = false;
}

export function messageSubagent(
  parentRequestId: string,
  agentId: string,
  message: string,
) {
  const agent = agents.get(agentId);
  if (!agent || agent.parentRequestId !== parentRequestId)
    throw new Error("子 Agent 不存在或不属于当前任务。");
  if (agent.status !== "running" || !agent.acceptingInstructions)
    throw new Error("子 Agent 正在结束或已经结束，无法追加指令。");
  const text = message.trim();
  if (!text) throw new Error("追加指令不能为空。");
  const queue = messageQueues.get(agent.requestId);
  if (!queue) throw new Error("子 Agent 指令通道已经关闭。");
  queue.push(text);
  agent.instructions.push(text);
  return publicState(agent);
}

export function drainSubagentMessages(requestId: string) {
  const queue = messageQueues.get(requestId);
  if (!queue?.length) return [];
  return queue.splice(0, queue.length);
}

export function claimSubagentMutation(
  requestId: string,
  root: string,
  paths: string[],
) {
  const agent = recordByRequestId(requestId);
  if (!agent || !paths.length) return undefined;
  const owners =
    mutationOwners.get(agent.rootRequestId) ?? new Map<string, string>();
  const normalizedPaths = paths.map((item) =>
    path.resolve(root, item).toLowerCase(),
  );
  for (const normalized of normalizedPaths) {
    const owner = owners.get(normalized);
    if (owner && owner !== agent.id) {
      const other = agents.get(owner);
      throw new Error(
        `并行修改冲突：${path.relative(root, normalized)} 已由子 Agent“${other?.name ?? owner}”负责。请让主 Agent 合并或重新分配文件。`,
      );
    }
  }
  for (const normalized of normalizedPaths) owners.set(normalized, agent.id);
  mutationOwners.set(agent.rootRequestId, owners);
  return (committed: boolean) => {
    if (committed) return;
    for (const normalized of normalizedPaths)
      if (owners.get(normalized) === agent.id) owners.delete(normalized);
  };
}

export async function waitForSubagents(
  parentRequestId: string,
  agentIds?: string[],
) {
  const selected = agentIds?.length
    ? agentIds.map((id) => {
        const agent = agents.get(id);
        if (!agent || agent.parentRequestId !== parentRequestId)
          throw new Error(`子 Agent ${id} 不存在或不属于当前任务。`);
        return agent;
      })
    : directChildren(parentRequestId);
  if (!selected.length) throw new Error("当前任务没有可等待的子 Agent。");
  await Promise.all(selected.map((agent) => agent.promise));
  return selected.map((agent) => {
    const usageDelta = agent.usageReported
      ? { input: 0, output: 0, cached: 0 }
      : { ...agent.usage };
    const result = { ...resultState(agent), usageDelta };
    agent.usageReported = true;
    compactCollectedRecord(agent);
    return result;
  });
}

export async function stopSubagent(parentRequestId: string, agentId: string) {
  const agent = agents.get(agentId);
  if (!agent || agent.parentRequestId !== parentRequestId)
    throw new Error("子 Agent 不存在或不属于当前任务。");
  if (agent.status === "running") {
    agent.status = "stopping";
    agent.acceptingInstructions = false;
    agent.controller.abort();
  }
  let timedOut = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    agent.promise,
    new Promise<void>(
      (resolve) =>
        (stopTimer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, STOP_GRACE_MS)),
    ),
  ]);
  if (stopTimer) clearTimeout(stopTimer);
  if (timedOut)
    agent.error = "停止信号已发送，但底层工具尚未退出；清理将在后台继续。";
  const usageDelta = agent.usageReported
    ? { input: 0, output: 0, cached: 0 }
    : { ...agent.usage };
  const result = { ...resultState(agent), usageDelta };
  agent.usageReported = true;
  compactCollectedRecord(agent);
  return result;
}

export async function stopSubagentsForParent(
  parentRequestId: string,
  remove = false,
) {
  const selected = directChildren(parentRequestId);
  for (const agent of selected) {
    agent.acceptingInstructions = false;
    const active = agent.status === "running" || agent.status === "stopping";
    if (agent.status === "running") agent.status = "stopping";
    if (active) agent.controller.abort();
  }
  await Promise.allSettled(selected.map((agent) => agent.promise));
  if (remove)
    for (const agent of selected) {
      agents.delete(agent.id);
      messageQueues.delete(agent.requestId);
    }
}

export function beginSubagentCleanup(parentRequestIds: string[]) {
  const ids = new Set<string>();
  const records = new Set<SubagentRecord>();
  for (const parentRequestId of parentRequestIds) {
    for (const requestId of descendantRequestIds.get(parentRequestId) ?? [])
      ids.add(requestId);
    for (const agent of agents.values())
      if (
        agent.parentRequestId === parentRequestId ||
        ids.has(agent.requestId)
      ) {
        ids.add(agent.requestId);
        records.add(agent);
      }
  }
  for (const agent of records) {
    agent.acceptingInstructions = false;
    if (agent.status === "running") agent.status = "stopping";
    agent.controller.abort();
  }
  return {
    requestIds: [...ids],
    async settle() {
      await Promise.allSettled([...records].map((agent) => agent.promise));
      for (const agent of records) {
        agents.delete(agent.id);
        messageQueues.delete(agent.requestId);
      }
      for (const parentRequestId of parentRequestIds) {
        descendantRequestIds.delete(parentRequestId);
        mutationOwners.delete(parentRequestId);
      }
    },
  };
}

export async function cleanupSubagentRecords(parentRequestIds: string[]) {
  const cleanup = beginSubagentCleanup(parentRequestIds);
  await cleanup.settle();
  return cleanup.requestIds;
}

export function subagentCheckpoints(
  parentRequestId: string,
): SubagentCheckpoint[] {
  const ids = descendantRequestIds.get(parentRequestId) ?? new Set<string>();
  return [...agents.values()]
    .filter(
      (agent) =>
        agent.parentRequestId === parentRequestId || ids.has(agent.requestId),
    )
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      task: redactSensitiveText(agent.task),
      status: agent.status,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      error: agent.error,
    }));
}

export function releaseSubagentRecords(parentRequestId: string) {
  const ids = descendantRequestIds.get(parentRequestId) ?? new Set<string>();
  for (const [id, agent] of agents)
    if (ids.has(agent.requestId)) {
      agents.delete(id);
      messageQueues.delete(agent.requestId);
    }
  for (const requestId of ids) descendantRequestIds.delete(requestId);
  mutationOwners.delete(parentRequestId);
}

export async function closeAllSubagents() {
  for (const agent of agents.values()) {
    agent.acceptingInstructions = false;
    agent.controller.abort();
  }
  await Promise.allSettled([...agents.values()].map((agent) => agent.promise));
  agents.clear();
  messageQueues.clear();
  descendantRequestIds.clear();
  mutationOwners.clear();
  eventSinks.clear();
}

export async function resetSubagentsForTests() {
  await closeAllSubagents();
}
