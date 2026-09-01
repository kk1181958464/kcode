import type {
  AgentActivity,
  AgentCompletionResult,
  AgentToolName,
} from "./types";

const mutationTools = new Set<AgentToolName>([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
  "ssh_write_file",
]);

const commandTools = new Set<AgentToolName>([
  "run_command",
  "ssh_run",
  "start_process",
  "stop_process",
  "diagnostics",
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
]);

function successful(activity: AgentActivity) {
  return activity.status === "success" || activity.status === "completed";
}

/** Builds a pause result from the activities already persisted in the UI. */
export function completionResultFromActivities(
  activities: readonly AgentActivity[],
  notice = "任务已暂停，已有执行记录和部分结果已保留。",
): AgentCompletionResult {
  let successfulTools = 0;
  let failedTools = 0;
  let additions = 0;
  let deletions = 0;
  const changedFiles = new Map<string, true>();
  const transfers = new Map<
    string,
    {
      direction: "download" | "upload";
      source: string;
      destination: string;
    }
  >();
  const operations = new Set<string>();

  for (const activity of activities) {
    if (successful(activity)) successfulTools += 1;
    else if (activity.status === "failed" || activity.status === "denied")
      failedTools += 1;
    if (!successful(activity) || activity.undone) continue;

    for (const operation of activity.operationEvidence ?? [])
      operations.add(`coding:${operation}`);
    for (const operation of activity.browserOperationEvidence ?? [])
      operations.add(`browser:${operation}`);
    if (activity.tool === "ssh_download_file") {
      operations.add("coding:download");
      const source = String(activity.input.remotePath ?? "").trim();
      const destination = String(
        activity.path ?? activity.input.localPath ?? "",
      ).trim();
      if (destination)
        transfers.set(`download:${source}:${destination}`, {
          direction: "download",
          source,
          destination,
        });
    } else if (activity.tool === "ssh_upload_file") {
      operations.add("coding:upload");
      const source = String(activity.input.localPath ?? "").trim();
      const destination = String(
        activity.path ?? activity.input.remotePath ?? "",
      ).trim();
      if (destination)
        transfers.set(`upload:${source}:${destination}`, {
          direction: "upload",
          source,
          destination,
        });
    } else if (mutationTools.has(activity.tool))
      operations.add("coding:modify");
    if (commandTools.has(activity.tool)) operations.add("coding:execute");

    if (!mutationTools.has(activity.tool)) continue;
    if (activity.fileChanges?.length) {
      for (const change of activity.fileChanges) {
        const filePath = String(change.path || "").trim();
        if (filePath) changedFiles.set(filePath, true);
        additions += Math.max(0, Number(change.additions) || 0);
        deletions += Math.max(0, Number(change.deletions) || 0);
      }
    } else {
      const filePath = String(activity.path || "").trim();
      if (filePath) changedFiles.set(filePath, true);
      additions += Math.max(0, Number(activity.additions) || 0);
      deletions += Math.max(0, Number(activity.deletions) || 0);
    }
  }

  return {
    kind: "incomplete",
    operations: [...operations].sort(),
    missingOperations: [],
    toolCalls: activities.length,
    successfulTools,
    failedTools,
    changedFiles: [...changedFiles.keys()],
    ...(transfers.size ? { transfers: [...transfers.values()] } : {}),
    additions,
    deletions,
    notice,
  };
}

const operationLabels: Record<string, string> = {
  "coding:modify": "实际修改",
  "coding:execute": "执行命令",
  "coding:validate": "验证",
  "coding:upload": "上传文件",
  "coding:download": "下载文件",
};

/** Formats a compact, visible conclusion for a paused run. */
export function pausedCompletionNarrative(
  result: AgentCompletionResult,
  prefix = "任务已暂停，已有结果已保留。",
) {
  const lines = [
    prefix,
    "",
    `已执行 ${result.toolCalls} 项工具记录，其中 ${result.successfulTools} 项成功${result.failedTools ? `，${result.failedTools} 项失败` : ""}。`,
  ];
  const downloads = (result.transfers ?? []).filter(
    (transfer) => transfer.direction === "download",
  );
  const uploads = (result.transfers ?? []).filter(
    (transfer) => transfer.direction === "upload",
  );
  if (downloads.length) {
    lines.push(
      `已下载 ${downloads.length} 个文件到本地：`,
      ...downloads.slice(0, 12).map((transfer) => `- ${transfer.destination}`),
    );
  }
  if (uploads.length) {
    lines.push(
      `已上传 ${uploads.length} 个文件到远程：`,
      ...uploads.slice(0, 12).map((transfer) => `- ${transfer.destination}`),
    );
  }
  if (result.changedFiles.length) {
    lines.push(
      `已检测到 ${result.changedFiles.length} 个文件有实际改动（+${result.additions} -${result.deletions}）：`,
      ...result.changedFiles.slice(0, 12).map((file) => `- ${file}`),
    );
    if (result.changedFiles.length > 12)
      lines.push(`- 还有 ${result.changedFiles.length - 12} 个文件未展开`);
  } else if (!downloads.length && !uploads.length) {
    lines.push("尚未检测到结构化文件差异，已有命令和检查记录仍已保留。");
  }
  if (result.missingOperations.length) {
    lines.push(
      `尚未确认：${result.missingOperations
        .map((operation) => operationLabels[operation] ?? operation)
        .join("、")}。`,
    );
  }
  if (result.notice && result.notice !== prefix) lines.push(result.notice);
  return lines.join("\n");
}
