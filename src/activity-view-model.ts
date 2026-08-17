import type { AgentActivity, AgentToolName, ReasoningEffort } from "./types";
import { activityTarget } from "./lib/format";

export type ActivityViewKind =
  | "command"
  | "file"
  | "agent"
  | "query"
  | "browser"
  | "other";

export type NormalizedActivity = {
  id: string;
  kind: ActivityViewKind;
  status: AgentActivity["status"];
  statusLabel: string;
  title: string;
  target: string;
  live: boolean;
  successful: boolean;
  failed: boolean;
  recoverable: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  exitCode?: number;
};

const commandTools = new Set<AgentToolName>([
  "run_command",
  "ssh_run",
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
  "start_process",
  "stop_process",
  "diagnostics",
]);
const queryTools = new Set<AgentToolName>([
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
]);
const agentTools = new Set<AgentToolName>([
  "update_plan",
  "spawn_agent",
  "list_agents",
  "message_agent",
  "wait_agent",
  "stop_agent",
]);
const fileTools = new Set<AgentToolName>([
  "write_file",
  "apply_patch",
  "move_path",
  "delete_path",
  "ssh_write_file",
  "ssh_download_file",
]);
const browserTools = new Set<AgentToolName>([
  "browser_open",
  "browser_type",
  "browser_click",
  "browser_snapshot",
  "browser_screenshot",
  "browser_record_start",
  "browser_record_stop",
]);

function activityKind(tool: AgentToolName): ActivityViewKind {
  if (queryTools.has(tool)) return "query";
  if (commandTools.has(tool)) return "command";
  if (agentTools.has(tool)) return "agent";
  if (fileTools.has(tool)) return "file";
  if (browserTools.has(tool)) return "browser";
  return "other";
}

function statusLabel(activity: AgentActivity) {
  if (activity.status === "waiting") return "等待确认";
  if (activity.status === "running") return "执行中";
  if (activity.status === "success") return "完成";
  if (activity.status === "completed") return `退出码 ${activity.exitCode ?? "非0"}`;
  if (activity.status === "denied") return "已阻止";
  return activity.recoverable ? "访问受限" : "失败";
}

export function normalizeActivity(activity: AgentActivity): NormalizedActivity {
  const status = activity.status;
  return {
    id: activity.id,
    kind: activityKind(activity.tool),
    status,
    statusLabel: statusLabel(activity),
    title: activity.title,
    target: activityTarget(activity),
    live: status === "running" || status === "waiting",
    successful: status === "success" || status === "completed",
    failed: status === "failed" || status === "denied",
    recoverable: Boolean(activity.recoverable),
    model:
      activity.modelDisplayName || activity.modelId ||
      (typeof activity.input.model === "string"
        ? activity.input.model
        : undefined),
    reasoningEffort: activity.reasoningEffort,
    exitCode: activity.exitCode,
  };
}

export type ActivityViewSummary = {
  commands: number;
  agents: number;
  completed: number;
  failures: number;
  limited: number;
  active?: AgentActivity;
  last?: AgentActivity;
  waiting: boolean;
};

export function summarizeActivities(
  activities: readonly AgentActivity[],
): ActivityViewSummary {
  let commands = 0;
  let agents = 0;
  let completed = 0;
  let failures = 0;
  let limited = 0;
  let active: AgentActivity | undefined;
  for (const activity of activities) {
    const view = normalizeActivity(activity);
    if (view.kind === "command" || view.kind === "query") commands += 1;
    if (activity.tool === "spawn_agent") agents += 1;
    if (view.successful) completed += 1;
    if (view.failed && view.recoverable) limited += 1;
    else if (view.failed) failures += 1;
    if (view.live) active = activity;
  }
  return {
    commands,
    agents,
    completed,
    failures,
    limited,
    active,
    last: activities.at(-1),
    waiting: active?.status === "waiting",
  };
}
