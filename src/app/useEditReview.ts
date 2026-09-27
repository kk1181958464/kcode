import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TaskRecord } from "../models";
import type { AgentActivity, EditCheckpointInfo } from "../types";
import { localWorkspacePath } from "../task-workspace";
import {
  latestRequestActivities,
  summarizeStatusActivities,
} from "../status-summary";

type EditReviewBindings = {
  activeTask: TaskRecord;
  activeTaskId: string;
  runningId?: string;
  activities: AgentActivity[];
  statusActivities: AgentActivity[];
  setActivities: Dispatch<SetStateAction<AgentActivity[]>>;
  setTasks: Dispatch<SetStateAction<TaskRecord[]>>;
  refreshGitState: (includeDiff?: boolean) => Promise<void>;
  flashAppToast: (message: string, tone?: "success" | "error") => void;
};

export function useEditReview({
  activeTask,
  activeTaskId,
  runningId,
  activities,
  statusActivities,
  setActivities,
  setTasks,
  refreshGitState,
  flashAppToast,
}: EditReviewBindings) {
  const [editCheckpoints, setEditCheckpoints] = useState<EditCheckpointInfo[]>(
    [],
  );

  async function refreshEditCheckpoints(requestId?: string) {
    if (!window.kcode?.chat.editCheckpoints) {
      setEditCheckpoints([]);
      return;
    }
    try {
      const items = await window.kcode.chat.editCheckpoints(requestId);
      setEditCheckpoints(items);
    } catch {
      setEditCheckpoints([]);
    }
  }

  function activityTouchesPaths(activity: AgentActivity, paths: Set<string>) {
    if (!paths.size) return false;
    if (activity.path && paths.has(activity.path.replaceAll("\\", "/")))
      return true;
    return Boolean(
      activity.fileChanges?.some((change) =>
        paths.has(change.path.replaceAll("\\", "/")),
      ),
    );
  }

  function applyActivityReviewState(input: {
    activityIds?: string[];
    requestId?: string;
    paths?: string[];
    patch: Partial<AgentActivity>;
  }) {
    const idSet = new Set(input.activityIds ?? []);
    const pathSet = new Set(
      (input.paths ?? []).map((item) => item.replaceAll("\\", "/")),
    );
    if (!idSet.size && !pathSet.size) return;
    const match = (activity: AgentActivity) => {
      if (idSet.has(activity.id)) return true;
      if (input.requestId && activity.requestId !== input.requestId)
        return false;
      return activityTouchesPaths(activity, pathSet);
    };
    setActivities((all) =>
      all.map((activity) =>
        match(activity) ? { ...activity, ...input.patch } : activity,
      ),
    );
    setTasks((all) =>
      all.map((task) =>
        task.id !== activeTaskId
          ? task
          : {
              ...task,
              activities: task.activities.map((activity) =>
                match(activity) ? { ...activity, ...input.patch } : activity,
              ),
            },
      ),
    );
  }

  async function keepFileChanges(paths?: string[]) {
    const workspacePath = activeTask
      ? localWorkspacePath(activeTask)
      : undefined;
    const requestId =
      runningId || activeTask?.runningId || activities.at(-1)?.requestId;
    if (!window.kcode?.chat.keepFiles || !workspacePath || !requestId) return;
    const result = await window.kcode.chat.keepFiles(
      workspacePath,
      requestId,
      paths,
    );
    if (result.success) {
      const fallbackPaths =
        result.paths.length > 0
          ? result.paths
          : paths?.length
            ? paths
            : summarizeStatusActivities(
                latestRequestActivities(activities, requestId),
              )
                .fileChanges.filter((change) => change.pending && !change.kept)
                .map((change) => change.path);
      applyActivityReviewState({
        activityIds: result.activityIds,
        requestId,
        paths: fallbackPaths,
        patch: { kept: true, undoable: false },
      });
      await refreshEditCheckpoints(requestId);
      void refreshGitState();
    }
  }

  async function undoFileChanges(paths?: string[]) {
    const workspacePath = activeTask
      ? localWorkspacePath(activeTask)
      : undefined;
    const requestId =
      runningId || activeTask?.runningId || activities.at(-1)?.requestId;
    if (!window.kcode?.chat.undoFiles || !workspacePath || !requestId) return;
    const undoFiles = window.kcode.chat.undoFiles;
    const results = [await undoFiles(workspacePath, requestId, paths)];
    const conflictPaths = results[0].conflictPaths ?? [];
    // Force only the conflicting files; forcing the whole batch would also
    // revert files the user chose to keep.
    if (conflictPaths.length && confirmOverwriteConflicts(conflictPaths))
      results.push(
        await undoFiles(workspacePath, requestId, conflictPaths, true),
      );
    const undone = results.filter((result) => result.success);
    if (undone.length) {
      applyActivityReviewState({
        activityIds: undone.flatMap((result) => result.activityIds),
        requestId,
        paths: undone.flatMap((result) =>
          result.paths.length ? result.paths : (paths ?? []),
        ),
        patch: { undone: true, undoable: false, kept: false },
      });
      await refreshEditCheckpoints(requestId);
      void refreshGitState(true);
    }
    const last = results.at(-1)!;
    if (!last.success && !last.conflict) flashAppToast(last.message, "error");
  }

  function confirmOverwriteConflicts(conflictPaths: string[]) {
    const listed = conflictPaths.slice(0, 5).join("\n");
    const more =
      conflictPaths.length > 5 ? `\n……等 ${conflictPaths.length} 个文件` : "";
    return window.confirm(
      `以下文件在智能体修改之后又被改动过，撤销会覆盖这些后续改动：\n\n${listed}${more}\n\n仍要撤销吗？`,
    );
  }

  async function restoreEditCheckpoint(checkpointId: string) {
    if (!window.kcode?.chat.restoreEditCheckpoint) return;
    let result = await window.kcode.chat.restoreEditCheckpoint(checkpointId);
    // A checkpoint restores the whole turn, so a forced retry is scoped to it.
    if (
      result.conflictPaths?.length &&
      confirmOverwriteConflicts(result.conflictPaths)
    ) {
      const forced = await window.kcode.chat.restoreEditCheckpoint(
        checkpointId,
        true,
      );
      result = forced.success
        ? {
            ...forced,
            paths: [...result.paths, ...forced.paths],
            activityIds: [...result.activityIds, ...forced.activityIds],
          }
        : forced;
    }
    if (!result.success && !result.conflict)
      flashAppToast(result.message, "error");
    if (result.success) {
      const requestId =
        editCheckpoints.find((item) => item.id === checkpointId)?.requestId ||
        runningId ||
        activities.at(-1)?.requestId;
      applyActivityReviewState({
        activityIds: result.activityIds,
        requestId,
        paths: result.paths,
        patch: { undone: true, undoable: false, kept: false },
      });
      await refreshEditCheckpoints(requestId);
      void refreshGitState(true);
    }
  }

  useEffect(() => {
    const requestId =
      runningId ?? activeTask?.runningId ?? statusActivities.at(-1)?.requestId;
    void refreshEditCheckpoints(requestId);
  }, [activeTask?.runningId, runningId, statusActivities]);

  return {
    editCheckpoints,
    keepFileChanges,
    undoFileChanges,
    restoreEditCheckpoint,
  };
}
