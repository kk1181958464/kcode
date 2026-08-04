import type { AgentActivity } from "../types";

// Canonical error-to-string: replaces the `e instanceof Error ? ... : String(e)`
// idiom that was copy-pasted across the codebase.
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const formatDuration = (milliseconds: number) =>
  milliseconds < 1000
    ? "<1 秒"
    : `${Math.floor(milliseconds / 60000) ? `${Math.floor(milliseconds / 60000)} 分 ` : ""}${Math.floor((milliseconds % 60000) / 1000)} 秒`;

export const formatCompactDuration = (milliseconds: number) => {
  if (milliseconds < 1000) return "<1s";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

export function clipWorkingText(text: string, max = 48) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length > 1) {
    const tail = parts.slice(-2).join("/");
    if (tail.length <= max) return tail;
    return `${tail.slice(0, Math.max(8, max - 1))}…`;
  }
  return `${value.slice(0, Math.max(8, max - 1))}…`;
}

export function activityTarget(activity: AgentActivity) {
  const raw =
    activity.command ||
    activity.path ||
    String(activity.input.sql || "") ||
    String(activity.input.query || "") ||
    String(activity.input.operation || "") ||
    String(activity.input.collection || "") ||
    String(activity.input.host || "") ||
    String(activity.input.name || "") ||
    String(activity.input.task || "") ||
    String(activity.input.agentId || "") ||
    String(activity.input.url || "") ||
    String(activity.input.branch || "") ||
    String(activity.input.remote || "") ||
    "";
  return clipWorkingText(String(raw));
}

export function activityFocus(activity: AgentActivity) {
  const target = activityTarget(activity);
  return target ? `${activity.title} · ${target}` : activity.title;
}

export function workingPhase(activities: AgentActivity[], elapsedMs: number) {
  const active = [...activities]
    .reverse()
    .find(
      (activity) =>
        activity.status === "running" || activity.status === "waiting",
    );
  const last = activities.at(-1);
  if (active) {
    const focus = activityFocus(active);
    if (active.status === "waiting") {
      return {
        phase: `等待确认：${focus}`,
        detail: "需要你允许后才会继续执行",
      };
    }
    if (active.tool === "ssh_run") {
      return {
        phase: `正在执行远程命令：${activityTarget(active) || active.title}`,
        detail: `已等待 ${formatDuration(elapsedMs)}`,
      };
    }
    if (active.tool === "mysql_query" || active.tool === "sqlserver_query") {
      return {
        phase: `正在${focus}`,
        detail: "查询返回前会持续等待，长 SQL 或锁等待可能较久",
      };
    }
    if (active.tool === "run_command") {
      return {
        phase: `正在运行命令：${activityTarget(active) || active.title}`,
        detail: "命令仍在执行中",
      };
    }
    return {
      phase: `正在${focus}`,
      detail: "工具执行中",
    };
  }
  if (last?.status === "failed") {
    if (last.recoverable)
      return {
        phase: `访问受限：${activityFocus(last)}`,
        detail: "正在切换到可用的本地或原生工具方案",
      };
    return {
      phase: `刚失败：${activityFocus(last)}`,
      detail: "正在分析失败原因并调整下一步",
    };
  }
  if (last) {
    return {
      phase: `已完成：${activityFocus(last)}`,
      detail: "正在根据结果规划下一步",
    };
  }
  if (elapsedMs > 12_000) {
    return {
      phase: "模型仍在生成规划",
      detail: "较久未返回时，可能是上游响应慢或上下文较大",
    };
  }
  return {
    phase: "正在思考并规划步骤",
    detail: "准备选择下一步工具",
  };
}
