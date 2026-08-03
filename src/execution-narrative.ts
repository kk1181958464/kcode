import type { AgentActivity } from "./types";

export const EXECUTION_NARRATIVE_VISIBLE_LIMIT = 320;
const EXECUTION_NARRATIVE_DEDUP_MIN = 24;

const NUMBERED_PLAN_LINE =
  /^\s*(?:(?:\d{1,2})\s*[.)、:]|第\s*[一二三四五六七八九十\d]{1,3}\s*步)\s*.+$/;

const INSPECTION_TOOLS = new Set<AgentActivity["tool"]>([
  "list_directory",
  "glob_files",
  "path_info",
  "read_file",
  "read_many_files",
  "search_code",
  "git_status",
  "git_remote_status",
  "git_diff",
  "git_log",
  "git_show",
  "web_search",
  "fetch_url",
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "ssh_list_directory",
  "ssh_read_file",
]);

const MUTATION_TOOLS = new Set<AgentActivity["tool"]>([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_download_file",
]);

function activityLabel(activity: AgentActivity) {
  const raw =
    activity.command ||
    activity.path ||
    String(activity.input.query || "") ||
    String(activity.input.url || "") ||
    String(activity.input.name || "") ||
    String(activity.input.task || "");
  const target = raw.replace(/\s+/g, " ").trim();
  if (!target) return `“${activity.title}”`;
  const clipped = target.length > 72 ? `${target.slice(0, 71)}…` : target;
  return `“${activity.title} · ${clipped}”`;
}

export function normalizeExecutionNarrative(value: string, max = 1_200) {
  const normalized = value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function executionNarrativeSource(value: string) {
  const visible = value
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, "")
    .replace(/<\/?think(?:ing)?>/gi, "");
  const lines = visible.split(/\r?\n/);
  const planLineCount = lines.filter((line) =>
    NUMBERED_PLAN_LINE.test(line),
  ).length;
  return {
    planLineCount,
    value: normalizeExecutionNarrative(
      planLineCount >= 2
        ? lines.filter((line) => !NUMBERED_PLAN_LINE.test(line)).join("\n")
        : visible,
      16_000,
    ),
  };
}

function trimNarrativeContinuation(value: string) {
  return value.replace(/^[\s,，。；;:：、-]+/, "").trim();
}

/** Removes text replayed by the model at the start of an adjacent tool round. */
export function dedupeExecutionNarrative(value: string, previous: string) {
  const current = executionNarrativeSource(value).value;
  const prior = executionNarrativeSource(previous).value;
  if (!current || !prior) return current;

  if (
    current.length >= EXECUTION_NARRATIVE_DEDUP_MIN &&
    prior.startsWith(current)
  )
    return "";
  if (
    prior.length >= EXECUTION_NARRATIVE_DEDUP_MIN &&
    current.startsWith(prior)
  )
    return trimNarrativeContinuation(current.slice(prior.length));

  const maxOverlap = Math.min(prior.length, current.length);
  for (
    let length = maxOverlap;
    length >= EXECUTION_NARRATIVE_DEDUP_MIN;
    length -= 1
  ) {
    if (prior.endsWith(current.slice(0, length)))
      return trimNarrativeContinuation(current.slice(length));
  }
  return current;
}

/** Keeps tool-call narration useful without letting it replace the activity UI. */
export function executionNarrativePreview(
  value: string,
  max = EXECUTION_NARRATIVE_VISIBLE_LIMIT,
) {
  const source = executionNarrativeSource(value);
  const preview = normalizeExecutionNarrative(source.value, max);
  if (preview) return preview;
  return source.planLineCount >= 2 ? "已整理执行计划，开始落实具体步骤。" : "";
}

export function activityExecutionNarrative(activity: AgentActivity) {
  const persisted = normalizeExecutionNarrative(activity.narrative || "");
  if (persisted) return persisted;
  const target = activityLabel(activity);

  if (INSPECTION_TOOLS.has(activity.tool))
    return `先执行${target}，确认当前状态和关联实现，再决定后续修改。`;
  if (MUTATION_TOOLS.has(activity.tool))
    return `执行${target}，落实已经确认的修改，并在后续步骤中验证结果。`;
  if (
    activity.tool === "run_command" ||
    activity.tool === "ssh_run" ||
    activity.tool === "diagnostics" ||
    activity.tool === "start_process" ||
    activity.tool === "stop_process"
  )
    return `执行${target}，获取真实运行结果，用于验证现状或刚完成的修改。`;
  if (
    activity.tool === "mysql_query" ||
    activity.tool === "sqlserver_query" ||
    activity.tool === "mongodb_execute"
  )
    return `执行${target}，用实际查询结果确认数据状态后再继续。`;
  if (
    activity.tool === "spawn_agent" ||
    activity.tool === "wait_agent" ||
    activity.tool === "list_agents" ||
    activity.tool === "message_agent" ||
    activity.tool === "stop_agent"
  )
    return `执行${target}，推进并收集并行任务的实际结果。`;
  return `执行${target}，取得继续处理当前任务所需的信息。`;
}

export function nextExecutionNarrative(
  lastActivity?: AgentActivity,
  failedActivity?: AgentActivity,
) {
  if (failedActivity?.status === "denied")
    return `${activityLabel(failedActivity)}未获允许，正在改用当前权限范围内的方案。`;
  if (failedActivity?.recoverable)
    return `${activityLabel(failedActivity)}暂时受限，正在改用不依赖该服务的校验方案。`;
  if (failedActivity)
    return `${activityLabel(failedActivity)}未通过，正在分析错误输出并调整执行方案。`;
  if (lastActivity?.status === "completed")
    return `${activityLabel(lastActivity)}已执行完毕，正在判断返回结果是否需要进一步处理。`;
  if (lastActivity)
    return `${activityLabel(lastActivity)}已完成，正在核对结果并确定下一步。`;
  return "正在理解任务目标并确定第一步检查范围。";
}
