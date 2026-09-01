import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRole,
  AgentActivity,
  AgentEvent,
  PermissionMode,
  PermissionPolicy,
  ReasoningEffort,
  SubagentCheckpoint,
} from "../src/types";

const MAX_ACTIVE_SUBAGENTS_PER_ROOT = 8;
const MAX_TOTAL_SUBAGENTS_PER_ROOT = 12;
// A child completes its assigned scope directly. Preventing nested trees keeps
// a single parent task from expanding into an unbounded audit fan-out.
export const MAX_SUBAGENT_DEPTH = 1;
const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_RETAINED_TRANSCRIPT_CHARS = 2_000;
const MAX_RESULT_ACTIVITIES = 25;
const STOP_GRACE_MS = 10_000;
export const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;
export const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;

export type WaitForSubagentsOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  subscribeToSteering?: (listener: () => void) => () => void;
};

export type SubagentExecutionTarget = {
  agentRole: AgentRole;
  providerId: string;
  modelId: string;
  modelDisplayName: string;
  reasoningEffort: ReasoningEffort;
};

export type SubagentStatus =
  "running" | "stopping" | "completed" | "failed" | "stopped";

type SubagentRecord = {
  id: string;
  requestId: string;
  parentRequestId: string;
  rootRequestId: string;
  depth: number;
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
  progressVersion: number;
  instructions: string[];
  executionTarget?: SubagentExecutionTarget;
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

function publicState(agent: SubagentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    task: agent.task,
    status: agent.status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    usage: { ...agent.usage },
    collected: agent.usageReported,
    error: agent.error,
    executionTarget: agent.executionTarget
      ? { ...agent.executionTarget }
      : undefined,
  };
}

function resultState(agent: SubagentRecord) {
  const activityRecords = [...agent.activities.values()].map((activity) => ({
    ...activity,
    title: `${agent.name} · ${activity.title}`,
    subagentId: agent.id,
    subagentName: agent.name,
    ...agent.executionTarget,
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
    instructions: [...agent.instructions],
    activities,
    activityRecords,
  };
}

function compactCollectedRecord(agent: SubagentRecord) {
  agent.transcript = agent.transcript.slice(-MAX_RETAINED_TRANSCRIPT_CHARS);
  agent.activities.clear();
  agent.instructions = agent.instructions.slice(-5);
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
  executionTarget?: SubagentExecutionTarget,
) {
  const parent = recordByRequestId(parentRequestId);
  const rootRequestId = parent?.rootRequestId ?? parentRequestId;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH)
    throw new Error(
      "当前 Agent 已达到委派深度；请直接完成已分配范围，不要再创建下级 Agent。",
    );
  const active = [...agents.values()].filter(
    (agent) =>
      agent.rootRequestId === rootRequestId &&
      (agent.status === "running" || agent.status === "stopping"),
  ).length;
  if (active >= MAX_ACTIVE_SUBAGENTS_PER_ROOT)
    throw new Error(
      `当前任务已有 ${MAX_ACTIVE_SUBAGENTS_PER_ROOT} 个子 Agent 在运行，请先等待或停止部分任务。`,
    );
  const total = [...agents.values()].filter(
    (agent) => agent.rootRequestId === rootRequestId,
  ).length;
  if (total >= MAX_TOTAL_SUBAGENTS_PER_ROOT)
    throw new Error(
      `当前任务已创建 ${MAX_TOTAL_SUBAGENTS_PER_ROOT} 个子 Agent，请先合并已有结果再继续委派。`,
    );
  const id = randomUUID();
  const requestId = `subagent:${id}`;
  const controller = new AbortController();
  const record: SubagentRecord = {
    id,
    requestId,
    parentRequestId,
    rootRequestId,
    depth,
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
    progressVersion: 0,
    instructions: [],
    executionTarget,
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
        if (event.type === "text") {
          if (event.delta.trim()) record.progressVersion += 1;
          record.transcript = (record.transcript + event.delta).slice(
            -MAX_TRANSCRIPT_CHARS,
          );
        } else if (event.type === "usage")
          record.usage = {
            input: event.input,
            output: event.output,
            cached: event.cached ?? 0,
          };
        else if (event.type === "activity") {
          record.progressVersion += 1;
          record.activities.set(event.activity.id, event.activity);
          eventSinks.get(record.rootRequestId)?.({
            type: "activity",
            activity: {
              ...event.activity,
              requestId: record.rootRequestId,
              title: `${record.name} · ${event.activity.title}`,
              subagentId: record.id,
              subagentName: record.name,
              ...record.executionTarget,
            },
          });
        } else if (event.type === "progress") {
          // Progress text is still forwarded for a live UI, but transport and
          // reasoning heartbeats are not concrete child work. Only text,
          // activities, and activity output advance the stall token.
          if (!record.executionTarget) continue;
          eventSinks.get(record.rootRequestId)?.({
            type: "progress",
            message: `${record.executionTarget.modelDisplayName} · ${event.message}`,
          });
        } else if (event.type === "activity_output") {
          record.progressVersion += 1;
          const activity = record.activities.get(event.activityId);
          if (activity)
            activity.output =
              event.mode === "append"
                ? `${activity.output ?? ""}${event.value}`.slice(-100_000)
                : event.value.slice(-100_000);
          eventSinks.get(record.rootRequestId)?.({
            type: "activity_output",
            activityId: event.activityId,
            mode: event.mode,
            value: event.value,
          });
        } else if (event.type === "error") throw new Error(event.message);
      }
      record.status = controller.signal.aborted ? "stopped" : "completed";
    } catch (error) {
      record.status = controller.signal.aborted ? "stopped" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      record.error = record.error ? `${record.error}\n${message}` : message;
    } finally {
      record.acceptingInstructions = false;
      parentSignal.removeEventListener("abort", stopWithParent);
      record.completedAt = Date.now();
      messageQueues.delete(requestId);
      await stopSubagentsForParent(requestId, false);
      if (record.usageReported) releaseSubagentMutationClaims(record);
    }
  })();
  return publicState(record);
}

export function listSubagents(parentRequestId: string) {
  return directChildren(parentRequestId).map(publicState);
}

/**
 * Retained transcript tails of already-collected subagents, newest last. The
 * planner uses this to thread the previous executor's conclusion into the next
 * executor's task so a follow-up round does not restate the whole plan.
 */
export function collectedSubagentSummaries(parentRequestId: string) {
  return directChildren(parentRequestId)
    .filter((agent) => agent.usageReported && agent.transcript.trim())
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    .map((agent) => ({
      name: agent.name,
      status: agent.status,
      transcript: agent.transcript.trim(),
    }));
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

function releaseSubagentMutationClaims(agent: SubagentRecord) {
  const owners = mutationOwners.get(agent.rootRequestId);
  if (!owners) return;
  for (const [target, owner] of owners)
    if (owner === agent.id) owners.delete(target);
  if (!owners.size) mutationOwners.delete(agent.rootRequestId);
}

function activeSubagent(agent: SubagentRecord) {
  return agent.status === "running" || agent.status === "stopping";
}

function collectSubagentResult(agent: SubagentRecord) {
  const usageDelta = agent.usageReported
    ? { input: 0, output: 0, cached: 0 }
    : { ...agent.usage };
  agent.usageReported = true;
  const result = { ...resultState(agent), usageDelta };
  compactCollectedRecord(agent);
  releaseSubagentMutationClaims(agent);
  return result;
}

/** Collect finished children without opening another wait cycle. */
export function collectFinishedSubagentResults(parentRequestId: string) {
  return directChildren(parentRequestId)
    .filter(
      (agent) =>
        !activeSubagent(agent) &&
        !agent.usageReported &&
        (agent.status === "completed" ||
          agent.status === "failed" ||
          agent.status === "stopped"),
    )
    .map(collectSubagentResult);
}

export type WaitForSubagentsResult = {
  message: string;
  timedOut: boolean;
  interrupted: boolean;
  /** A child emitted concrete text, activity, or activity output during this wait. */
  progressed: boolean;
  completed: Array<ReturnType<typeof collectSubagentResult>>;
  pending: Array<ReturnType<typeof publicState>>;
};

/**
 * Wait for the first selected child update. A wait timeout only releases the
 * parent tool call; it never aborts, collects, or otherwise mutates a child.
 */
export async function waitForSubagents(
  parentRequestId: string,
  agentIds?: string[],
  options: WaitForSubagentsOptions = {},
): Promise<WaitForSubagentsResult> {
  const selected = agentIds?.length
    ? agentIds.map((id) => {
        const agent = agents.get(id);
        if (!agent || agent.parentRequestId !== parentRequestId)
          throw new Error(`子 Agent ${id} 不存在或不属于当前任务。`);
        return agent;
      })
    : directChildren(parentRequestId);
  if (!selected.length) throw new Error("当前任务没有可等待的子 Agent。");

  const timeoutMs = Math.min(
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
    Math.max(
      1,
      Math.floor(options.timeoutMs ?? DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS),
    ),
  );
  const startedAt = Date.now();
  const pendingAgents = () => selected.filter(activeSubagent);
  const readyAgents = () => selected.filter((agent) => !activeSubagent(agent));
  const pendingAtStart = pendingAgents();
  const progressAtStart = new Map(
    selected.map((agent) => [agent.id, agent.progressVersion]),
  );
  const collectedAtStart = new Map(
    selected.map((agent) => [agent.id, agent.usageReported]),
  );
  const freshReadyAtStart = readyAgents().filter(
    (agent) => !agent.usageReported,
  );
  const reportProgress = () => {
    const pending = pendingAgents();
    if (!pending.length) return;
    const elapsedSeconds = Math.max(
      1,
      Math.floor((Date.now() - startedAt) / 1_000),
    );
    options.onProgress?.(
      `已等待 ${elapsedSeconds} 秒；仍有 ${pending.length} 个子 Agent 在运行：${pending
        .map((agent) => agent.name)
        .join("、")}`,
    );
  };

  let outcome: "completed" | "timeout" | "aborted" | "steered" =
    freshReadyAtStart.length || !pendingAtStart.length
      ? "completed"
      : await (async () => {
          reportProgress();
          const progressTimer = options.onProgress
            ? setInterval(reportProgress, 15_000)
            : undefined;
          let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
          let removeAbortListener: () => void = () => undefined;
          let removeSteeringListener: () => void = () => undefined;
          const result = await Promise.race([
            ...pendingAgents().map((agent) =>
              agent.promise.then(() => "completed" as const),
            ),
            new Promise<"timeout">(
              (resolve) =>
                (timeoutTimer = setTimeout(
                  () => resolve("timeout"),
                  timeoutMs,
                )),
            ),
            new Promise<"aborted">((resolve) => {
              const signal = options.signal;
              if (!signal) return;
              if (signal.aborted) {
                resolve("aborted");
                return;
              }
              const onAbort = () => resolve("aborted");
              signal.addEventListener("abort", onAbort, { once: true });
              removeAbortListener = () =>
                signal.removeEventListener("abort", onAbort);
            }),
            new Promise<"steered">((resolve) => {
              removeSteeringListener =
                options.subscribeToSteering?.(() => resolve("steered")) ??
                (() => undefined);
            }),
          ]);
          if (progressTimer) clearInterval(progressTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          removeAbortListener();
          removeSteeringListener();
          return result;
        })();

  const ready = readyAgents();
  const completed = (
    pendingAtStart.length
      ? ready.filter((agent) => !agent.usageReported)
      : ready
  ).map(collectSubagentResult);
  const pending = pendingAgents().map(publicState);
  const timedOut = outcome === "timeout";
  const interrupted = outcome === "aborted" || outcome === "steered";
  const progressed =
    selected.some(
      (agent) => agent.progressVersion > (progressAtStart.get(agent.id) ?? 0),
    ) || completed.some((agent) => !(collectedAtStart.get(agent.id) ?? false));
  const message = completed.length
    ? `已有 ${completed.length} 个子 Agent 返回结果。`
    : timedOut
      ? `等待 ${Math.ceil(timeoutMs / 1_000)} 秒后暂无新结果；${pending.length} 个子 Agent 仍在后台运行。`
      : interrupted
        ? `等待已被新指令或父任务状态变化打断；${pending.length} 个子 Agent 仍在后台运行。`
        : "所选子 Agent 的结果已收集。";
  return { message, timedOut, interrupted, progressed, completed, pending };
}

/**
 * A cheap monotonic snapshot for the parent loop. It also notices a child
 * finishing between two list_agents calls, even when wait_agent was not used.
 */
export function subagentProgressToken(parentRequestId: string) {
  return directChildren(parentRequestId)
    .map(
      (agent) =>
        `${agent.id}:${agent.status}:${agent.progressVersion}:${agent.completedAt ?? 0}`,
    )
    .join("|");
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
  agent.usageReported = true;
  const result = { ...resultState(agent), usageDelta };
  compactCollectedRecord(agent);
  if (agent.status !== "stopping") releaseSubagentMutationClaims(agent);
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
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(selected.map((agent) => agent.promise)),
    new Promise<void>(
      (resolve) => (settleTimer = setTimeout(resolve, STOP_GRACE_MS)),
    ),
  ]);
  if (settleTimer) clearTimeout(settleTimer);
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
      task: agent.task,
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
