import type { TaskCollaboration, TaskRecord } from "./models";
import type { TaskRunStatus } from "./task-status";
import type { AgentActivity } from "./types";
import type { SshRemoteWorkspace } from "./ssh-remote-types";

/** Where the session executes from the user's point of view. */
export type AgentOverviewLocation = "local" | "ssh-remote" | "cloud";

/**
 * Board-facing lifecycle. Maps product runStatus + subagent states into a
 * small glanceable set (运行中 / 等待中 / 空闲 / 已完成 …).
 */
export type AgentOverviewPhase =
  | "running"
  | "waiting"
  | "idle"
  | "done"
  | "failed"
  | "stopped";

export type AgentOverviewKind = "session" | "subagent" | "cloud";

export type AgentOverviewRole =
  | "planner"
  | "executor"
  | "agent"
  | "subagent"
  | "cloud";

export type AgentOverviewRow = {
  /** Stable row id (task id, or taskId:subagentId, or cloud id). */
  id: string;
  kind: AgentOverviewKind;
  /** Conversation / agent display name. */
  name: string;
  role: AgentOverviewRole;
  roleLabel: string;
  location: AgentOverviewLocation;
  locationLabel: string;
  phase: AgentOverviewPhase;
  phaseLabel: string;
  /** Short secondary line (workspace, task snippet, model…). */
  detail?: string;
  /** Parent conversation to focus when the row is activated. */
  taskId: string;
  /** True when clicking should call onFocusSession(taskId). */
  focusable: boolean;
  active: boolean;
  updatedAt: number;
  /** Optional deep-link when the product later wires PR / file jumps. */
  relatedPath?: string;
  relatedUrl?: string;
};

export type AgentOverviewTaskInput = Pick<
  TaskRecord,
  | "id"
  | "name"
  | "workspaceName"
  | "workspacePath"
  | "localWorkspacePath"
  | "remoteWorkspace"
  | "archived"
  | "runningId"
  | "runStatus"
  | "updatedAt"
  | "collaboration"
  | "activities"
>;

export type BuildAgentOverviewOptions = {
  tasks: readonly AgentOverviewTaskInput[];
  activeTaskId?: string;
  /** Soft cap so the StatusPanel stays glanceable. */
  limit?: number;
  /**
   * Extension point for future cloud / remote agent providers.
   * Pass rows when a source is wired; leave empty/undefined to stay honest.
   */
  cloudAgents?: readonly AgentOverviewRow[];
  /** When false (default), show a cloud-unavailable hint instead of inventing rows. */
  cloudAvailable?: boolean;
};

export type AgentOverviewBoard = {
  rows: AgentOverviewRow[];
  localCount: number;
  cloudCount: number;
  runningCount: number;
  waitingCount: number;
  /** True when no cloud source is wired — UI should say so, not fake data. */
  cloudUnavailable: boolean;
};

const PHASE_LABEL: Record<AgentOverviewPhase, string> = {
  running: "运行中",
  waiting: "等待中",
  idle: "空闲",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const ROLE_LABEL: Record<AgentOverviewRole, string> = {
  planner: "规划",
  executor: "执行",
  agent: "会话",
  subagent: "子 Agent",
  cloud: "云端",
};

const LOCATION_LABEL: Record<AgentOverviewLocation, string> = {
  local: "本地",
  "ssh-remote": "SSH 远程",
  cloud: "云端",
};

export function agentOverviewPhaseLabel(phase: AgentOverviewPhase) {
  return PHASE_LABEL[phase];
}

export function agentOverviewRoleLabel(role: AgentOverviewRole) {
  return ROLE_LABEL[role];
}

export function agentOverviewLocationLabel(location: AgentOverviewLocation) {
  return LOCATION_LABEL[location];
}

export function phaseFromTaskRunStatus(
  runStatus: TaskRunStatus | undefined,
  runningId?: string,
): AgentOverviewPhase {
  if (runningId || runStatus === "running") return "running";
  if (runStatus === "blocked" || runStatus === "paused") return "waiting";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "stopped";
  if (runStatus === "completed") return "done";
  return "idle";
}

export function phaseFromSubagentStatus(
  status: string | undefined,
): AgentOverviewPhase {
  if (status === "running" || status === "stopping") return "running";
  if (status === "failed" || status === "denied") return "failed";
  if (status === "stopped") return "stopped";
  if (status === "completed" || status === "success") return "done";
  if (status === "waiting") return "waiting";
  return "idle";
}

function taskLocation(
  remoteWorkspace: SshRemoteWorkspace | undefined,
): AgentOverviewLocation {
  return remoteWorkspace ? "ssh-remote" : "local";
}

function workspaceDetail(task: AgentOverviewTaskInput) {
  if (task.remoteWorkspace) {
    const remote = task.remoteWorkspace;
    return `${remote.username}@${remote.host}:${remote.rootPath}`;
  }
  return (
    task.workspaceName ||
    task.localWorkspacePath ||
    task.workspacePath ||
    undefined
  );
}

function collaborationRole(task: AgentOverviewTaskInput): AgentOverviewRole {
  return task.collaboration?.mode === "planner-executor" ? "planner" : "agent";
}

function phaseRank(phase: AgentOverviewPhase) {
  switch (phase) {
    case "running":
      return 0;
    case "waiting":
      return 1;
    case "failed":
      return 2;
    case "stopped":
      return 3;
    case "done":
      return 4;
    default:
      return 5;
  }
}

/** Board only lists live work — completed/stopped/idle live in the sidebar. */
function isBoardPhase(phase: AgentOverviewPhase) {
  return phase === "running" || phase === "waiting";
}

/**
 * Collect unique subagent rows from a task's activity list.
 * Uses subagentId when present; falls back to spawn_agent tool rows.
 */
export function subagentRowsFromActivities(
  task: AgentOverviewTaskInput,
  activeTaskId?: string,
): AgentOverviewRow[] {
  const activities = task.activities ?? [];
  const byId = new Map<string, AgentOverviewRow>();

  for (const activity of activities) {
    const subId = activity.subagentId;
    if (subId) {
      const phase = phaseFromSubagentStatus(activity.status);
      const prev = byId.get(subId);
      const started = activity.startedAt || task.updatedAt;
      if (
        !prev ||
        phaseRank(phase) < phaseRank(prev.phase) ||
        started > prev.updatedAt
      ) {
        byId.set(subId, {
          id: `${task.id}:sub:${subId}`,
          kind: "subagent",
          name: activity.subagentName || subId,
          role: "subagent",
          roleLabel: ROLE_LABEL.subagent,
          location: taskLocation(task.remoteWorkspace),
          locationLabel: LOCATION_LABEL[taskLocation(task.remoteWorkspace)],
          phase,
          phaseLabel: PHASE_LABEL[phase],
          detail: activity.title || activity.command || task.name,
          taskId: task.id,
          focusable: true,
          active: task.id === activeTaskId,
          updatedAt: activity.completedAt || activity.startedAt || task.updatedAt,
        });
      }
      continue;
    }

    if (activity.tool === "spawn_agent") {
      const key = activity.id;
      if (byId.has(key)) continue;
      const phase = phaseFromSubagentStatus(activity.status);
      const spawnedName =
        typeof activity.input?.name === "string"
          ? activity.input.name
          : activity.title || "子 Agent";
      byId.set(key, {
        id: `${task.id}:spawn:${key}`,
        kind: "subagent",
        name: spawnedName,
        role: "subagent",
        roleLabel: ROLE_LABEL.subagent,
        location: taskLocation(task.remoteWorkspace),
        locationLabel: LOCATION_LABEL[taskLocation(task.remoteWorkspace)],
        phase,
        phaseLabel: PHASE_LABEL[phase],
        detail: task.name,
        taskId: task.id,
        focusable: true,
        active: task.id === activeTaskId,
        updatedAt: activity.completedAt || activity.startedAt || task.updatedAt,
      });
    }
  }

  return [...byId.values()];
}

function sessionRow(
  task: AgentOverviewTaskInput,
  activeTaskId?: string,
): AgentOverviewRow {
  const phase = phaseFromTaskRunStatus(task.runStatus, task.runningId);
  const role = collaborationRole(task);
  const location = taskLocation(task.remoteWorkspace);
  const collabHint =
    task.collaboration?.mode === "planner-executor" ||
    task.collaboration?.mode === "plan-confirm"
      ? collaborationModeLabel(task.collaboration)
      : undefined;
  const detailParts = [workspaceDetail(task), collabHint].filter(Boolean);
  return {
    id: `session:${task.id}`,
    kind: "session",
    name: task.name || "未命名会话",
    role,
    roleLabel: ROLE_LABEL[role],
    location,
    locationLabel: LOCATION_LABEL[location],
    phase,
    phaseLabel: PHASE_LABEL[phase],
    detail: detailParts.join(" · ") || undefined,
    taskId: task.id,
    focusable: true,
    active: task.id === activeTaskId,
    updatedAt: task.updatedAt,
  };
}

/**
 * Build a Windsurf-like Command Center lite board from local task/session
 * models (+ optional cloud rows). Only running/waiting rows (plus live subagents). Does not invent cloud agents.
 */
export function buildAgentOverviewBoard(
  options: BuildAgentOverviewOptions,
): AgentOverviewBoard {
  const limit = options.limit ?? 12;
  const cloudAgents = options.cloudAgents ?? [];
  const cloudAvailable = Boolean(options.cloudAvailable) || cloudAgents.length > 0;
  const activeTaskId = options.activeTaskId;

  const sessionRows: AgentOverviewRow[] = [];
  const subRows: AgentOverviewRow[] = [];

  for (const task of options.tasks) {
    if (task.archived) continue;
    const row = sessionRow(task, activeTaskId);
    const subs = subagentRowsFromActivities(task, activeTaskId);
    // Only running / waiting — do not flood with done/stopped/idle sessions.
    const liveSubs = subs.filter((sub) => isBoardPhase(sub.phase));
    const keepSession = isBoardPhase(row.phase) || liveSubs.length > 0;
    if (keepSession) sessionRows.push(row);
    subRows.push(...liveSubs);
  }

  const merged = [...sessionRows, ...subRows, ...cloudAgents].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const rank = phaseRank(a.phase) - phaseRank(b.phase);
    if (rank !== 0) return rank;
    return b.updatedAt - a.updatedAt;
  });

  const rows = merged.slice(0, limit);
  const localRows = rows.filter((row) => row.location !== "cloud");
  const cloudRows = rows.filter((row) => row.location === "cloud");

  return {
    rows,
    localCount: localRows.length,
    cloudCount: cloudRows.length,
    runningCount: rows.filter((row) => row.phase === "running").length,
    waitingCount: rows.filter((row) => row.phase === "waiting").length,
    cloudUnavailable: !cloudAvailable,
  };
}

/** Reserved hook so a future cloud provider can map into board rows. */
export function mapCloudAgentRow(input: {
  id: string;
  name: string;
  phase: AgentOverviewPhase;
  detail?: string;
  relatedUrl?: string;
  updatedAt?: number;
}): AgentOverviewRow {
  return {
    id: `cloud:${input.id}`,
    kind: "cloud",
    name: input.name,
    role: "cloud",
    roleLabel: ROLE_LABEL.cloud,
    location: "cloud",
    locationLabel: LOCATION_LABEL.cloud,
    phase: input.phase,
    phaseLabel: PHASE_LABEL[input.phase],
    detail: input.detail,
    taskId: "",
    focusable: Boolean(input.relatedUrl),
    active: false,
    updatedAt: input.updatedAt ?? 0,
    relatedUrl: input.relatedUrl,
  };
}

export function collaborationModeLabel(
  collaboration: TaskCollaboration | undefined,
) {
  if (collaboration?.mode === "planner-executor") return "规划+执行";
  if (collaboration?.mode === "plan-confirm") return "计划确认";
  return "单模型";
}
