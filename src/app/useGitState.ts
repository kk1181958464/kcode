import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskRecord } from "../models";
import type { AgentActivity, GitWorkspaceState } from "../types";
import { errorMessage } from "../lib/format";
import { localWorkspacePath } from "../task-workspace";
import { useEventCallback } from "../lib/use-event-callback";

const FILE_CHANGE_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "move_path",
  "delete_path",
  "ssh_write_file",
]);

const emptyGitState: GitWorkspaceState = {
  available: false,
  files: 0,
  additions: 0,
  deletions: 0,
  summary: "",
  diff: "",
};

type GitStateBindings = {
  activeTask: TaskRecord | undefined;
  activeTaskId: string;
  activities: AgentActivity[];
};

export function useGitState({
  activeTask,
  activeTaskId,
  activities,
}: GitStateBindings) {
  const [gitState, setGitState] = useState<GitWorkspaceState>(emptyGitState);
  const [gitRefreshing, setGitRefreshing] = useState(false);
  const gitRefreshActivityRef = useRef<string | undefined>(undefined);
  const gitRefreshSeqRef = useRef(0);
  const activeLocalProjectPath = activeTask
    ? localWorkspacePath(activeTask)
    : undefined;

  // Stable identity, latest closure: deferred callers (the file-change timer
  // below, child components) always refresh the task that is active now.
  const refreshGitState = useEventCallback(
    async (includeDiff: boolean = false) => {
      if (!window.kcode?.workspace.gitState || !activeTask) return;
      // Only the latest request may commit: after a task switch an older,
      // slower lookup for the previous project must not overwrite the result.
      const seq = ++gitRefreshSeqRef.current;
      const isLatest = () => seq === gitRefreshSeqRef.current;
      if (!activeLocalProjectPath) {
        setGitState({
          ...emptyGitState,
          error: activeTask.remoteWorkspace
            ? "未关联本地项目；SSH 远程 Git 请在执行记录中查看"
            : "未关联本地项目",
        });
        setGitRefreshing(false);
        return;
      }
      setGitRefreshing(true);
      try {
        const next = await window.kcode.workspace.gitState(
          activeLocalProjectPath,
          includeDiff,
        );
        if (isLatest()) setGitState(next);
      } catch (error) {
        if (isLatest())
          setGitState({ ...emptyGitState, error: errorMessage(error) });
      } finally {
        if (isLatest()) setGitRefreshing(false);
      }
    },
  );

  useEffect(() => {
    void refreshGitState(false);
  }, [activeTaskId, activeLocalProjectPath, refreshGitState]);

  const latestFileChangeActivity = useMemo(() => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (activity.status === "success" && FILE_CHANGE_TOOLS.has(activity.tool))
        return activity.id;
    }
    return undefined;
  }, [activities]);

  useEffect(() => {
    if (
      !latestFileChangeActivity ||
      gitRefreshActivityRef.current === latestFileChangeActivity
    )
      return;
    gitRefreshActivityRef.current = latestFileChangeActivity;
    const timer = window.setTimeout(() => void refreshGitState(), 300);
    return () => window.clearTimeout(timer);
  }, [latestFileChangeActivity, refreshGitState]);

  return { gitState, gitRefreshing, refreshGitState, activeLocalProjectPath };
}
