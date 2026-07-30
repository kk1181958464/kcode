import type { AgentActivity, AgentToolName } from "./types";
import type { TaskRunStatus } from "./task-status";

const FILE_TOOLS = new Set<AgentToolName>([
  "write_file",
  "apply_patch",
  "move_path",
  "delete_path",
  "ssh_write_file",
]);

const COMMAND_TOOLS = new Set<AgentToolName>([
  "run_command",
  "ssh_run",
  "mysql_query",
  "sqlserver_query",
  "mongodb_execute",
  "start_process",
  "stop_process",
  "diagnostics",
]);

const VALIDATION_COMMAND =
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)(?:\s|$)|\b(?:tsc|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i;

export type StatusFileChange = {
  path: string;
  additions: number;
  deletions: number;
  diffs: string[];
};

export type StatusOverviewTone = "running" | "success" | "failure" | "neutral";

/** The rail headline describes the request outcome, not an individual step. */
export function statusOverviewTone(
  runStatus: TaskRunStatus,
): StatusOverviewTone {
  if (runStatus === "running") return "running";
  if (runStatus === "completed") return "success";
  if (runStatus === "failed") return "failure";
  return "neutral";
}

export function latestRequestActivities(
  activities: AgentActivity[],
  runningId?: string,
) {
  const requestId = runningId || activities.at(-1)?.requestId;
  return requestId
    ? activities.filter((activity) => activity.requestId === requestId)
    : [];
}

export function isValidationActivity(activity: AgentActivity) {
  return (
    activity.tool === "diagnostics" ||
    (activity.tool === "run_command" &&
      VALIDATION_COMMAND.test(activity.command || ""))
  );
}

export function summarizeStatusActivities(activities: AgentActivity[]) {
  const files = new Map<string, StatusFileChange>();
  let commands = 0;
  let completed = 0;
  let failures = 0;
  let active: AgentActivity | undefined;

  for (const activity of activities) {
    if (COMMAND_TOOLS.has(activity.tool)) commands += 1;
    if (activity.status === "success" || activity.status === "completed")
      completed += 1;
    if (activity.status === "failed" || activity.status === "denied")
      failures += 1;
    if (activity.status === "running" || activity.status === "waiting")
      active = activity;

    if (
      !FILE_TOOLS.has(activity.tool) ||
      activity.status !== "success" ||
      activity.undone
    )
      continue;

    const changes = activity.fileChanges?.length
      ? activity.fileChanges
      : activity.path
        ? [
            {
              path: activity.path,
              additions: activity.additions ?? 0,
              deletions: activity.deletions ?? 0,
            },
          ]
        : [];
    for (const change of changes) {
      const current = files.get(change.path) ?? {
        path: change.path,
        additions: 0,
        deletions: 0,
        diffs: [],
      };
      current.additions += change.additions;
      current.deletions += change.deletions;
      const diff = change.diff || (changes.length === 1 ? activity.diff : "");
      if (diff && !current.diffs.includes(diff)) current.diffs.push(diff);
      files.set(change.path, current);
    }
  }

  const fileChanges = [...files.values()];
  return {
    total: activities.length,
    completed,
    failures,
    commands,
    active,
    last: activities.at(-1),
    fileChanges,
    additions: fileChanges.reduce((total, file) => total + file.additions, 0),
    deletions: fileChanges.reduce((total, file) => total + file.deletions, 0),
    results: activities.filter((activity) => COMMAND_TOOLS.has(activity.tool)),
    validations: activities.filter(isValidationActivity),
  };
}
