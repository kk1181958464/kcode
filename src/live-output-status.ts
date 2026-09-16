import { activityTarget } from "./lib/format";
import {
  classifyQuietStatus,
  type QuietStatusKind,
} from "./quiet-status";
import type { AgentActivity, AgentToolName } from "./types";

const INSPECT_TOOLS = new Set<string>([
  "read_file",
  "read_many_files",
  "path_info",
  "list_directory",
  "glob_files",
  "search_code",
  "ssh_list_directory",
  "ssh_read_file",
]);

export function isInspectTool(tool: AgentToolName | string) {
  if (INSPECT_TOOLS.has(tool)) return true;
  return /^(ssh_)?(read_|list_|glob_|path_info|search_code)/.test(tool);
}

export type LiveGapStatus = {
  kind?: QuietStatusKind;
  label: string;
  source: "progress" | "tool" | "token";
};

export type CollapsedInlineActivity =
  | { type: "item"; activity: AgentActivity }
  | {
      type: "inspect-group";
      id: string;
      activities: AgentActivity[];
      count: number;
      label: string;
      target: string;
      status: AgentActivity["status"];
    };

function latestActiveActivity(activities: readonly AgentActivity[]) {
  return [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.status === "running" || activity.status === "waiting",
    );
}

function toolGapLabel(activity: AgentActivity) {
  const target = activityTarget(activity);
  const withTarget = (label: string) => (target ? `${label} ${target}` : label);
  if (activity.status === "waiting") {
    return withTarget(`等待确认：${activity.title}`);
  }
  switch (activity.tool) {
    case "run_command":
      return withTarget("正在运行命令");
    case "ssh_run":
      return withTarget("正在运行远程命令");
    case "mysql_query":
    case "sqlserver_query":
    case "mongodb_execute":
      return withTarget("正在执行查询");
    case "apply_patch":
      return withTarget("正在应用修改");
    case "write_file":
    case "ssh_write_file":
      return withTarget("正在写入文件");
    case "move_path":
      return withTarget("正在移动文件");
    case "delete_path":
      return withTarget("正在删除文件");
    case "diagnostics":
      return withTarget("正在检查诊断");
    case "read_file":
    case "read_many_files":
    case "ssh_read_file":
      return withTarget("正在读取");
    case "list_directory":
    case "ssh_list_directory":
      return withTarget("正在列出目录");
    case "glob_files":
      return withTarget("正在匹配文件");
    case "search_code":
      return withTarget("正在搜索代码");
    case "path_info":
      return withTarget("正在查看路径");
    default:
      return withTarget(`正在${activity.title}`);
  }
}


/** Shorten stream timeout / transport auto-continue progress for the assistant tail. */
export function formatAutoContinueStatusLabel(message: string): string | undefined {
  const value = message.trim();
  if (!value || !/自动继续/.test(value)) return undefined;
  const count = value.match(/（(\d+\/\d+)）/)?.[1];
  const suffix = count ? `（${count}）…` : "…";
  if (/单轮安全边界|持续思考已达/.test(value)) {
    return `单轮超时，自动继续${suffix}`;
  }
  if (/上游响应流中断|响应流中断|上游.*中断/.test(value)) {
    return `上游中断，自动继续${suffix}`;
  }
  return count ? `自动继续${suffix}` : value;
}

export function deriveLiveGapStatus(
  activities: readonly AgentActivity[] = [],
  progressText = "",
): LiveGapStatus | null {
  const progress = progressText.trim();
  const kind = progress ? classifyQuietStatus(progress) : undefined;
  const active = latestActiveActivity(activities);
  if (active) {
    return { kind, label: toolGapLabel(active), source: "tool" };
  }
  if (progress) {
    const autoContinueLabel = formatAutoContinueStatusLabel(progress);
    return {
      // Keep auto-continue wording as the sole status; skip quiet-chip collapse.
      kind: autoContinueLabel ? undefined : kind,
      label: autoContinueLabel ?? progress,
      source: "progress",
    };
  }
  const last = activities.at(-1);
  if (last?.status === "failed") {
    return {
      kind,
      label: last.recoverable ? "正在切换可用方案…" : "正在分析失败原因…",
      source: "token",
    };
  }
  if (last?.status === "completed" || last?.status === "success") {
    return { kind, label: "正在根据结果继续…", source: "token" };
  }
  return { kind, label: "正在生成回复…", source: "token" };
}

function inspectGroupLabel(activities: readonly AgentActivity[]) {
  const live = activities.some(
    (activity) =>
      activity.status === "running" || activity.status === "waiting",
  );
  return live
    ? `正在查看 ${activities.length} 处`
    : `已查看 ${activities.length} 处`;
}

function mergeInspectStatus(
  current: AgentActivity["status"],
  next: AgentActivity["status"],
): AgentActivity["status"] {
  const rank: AgentActivity["status"][] = [
    "running",
    "waiting",
    "failed",
    "denied",
    "completed",
    "success",
  ];
  return rank.indexOf(next) < rank.indexOf(current) ? next : current;
}

export function collapseInlineToolActivities(
  activities: readonly AgentActivity[],
): CollapsedInlineActivity[] {
  const cards: CollapsedInlineActivity[] = [];
  for (const activity of activities) {
    const previous = cards.at(-1);
    if (!isInspectTool(activity.tool)) {
      cards.push({ type: "item", activity });
      continue;
    }
    if (previous?.type === "inspect-group") {
      previous.activities.push(activity);
      previous.count = previous.activities.length;
      previous.label = inspectGroupLabel(previous.activities);
      previous.target = activityTarget(activity) || previous.target;
      previous.status = mergeInspectStatus(previous.status, activity.status);
      continue;
    }
    if (
      previous?.type === "item" &&
      isInspectTool(previous.activity.tool)
    ) {
      const grouped = [previous.activity, activity];
      cards[cards.length - 1] = {
        type: "inspect-group",
        id: previous.activity.id,
        activities: grouped,
        count: grouped.length,
        label: inspectGroupLabel(grouped),
        target: activityTarget(activity) || activityTarget(previous.activity),
        status: mergeInspectStatus(previous.activity.status, activity.status),
      };
      continue;
    }
    cards.push({ type: "item", activity });
  }
  return cards;
}
