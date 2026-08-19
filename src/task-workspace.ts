import type { TaskRecord } from "./models";
import type { SshRemoteProfile, SshRemoteState } from "./ssh-remote-types";

type TaskWorkspaceIdentity = Pick<
  TaskRecord,
  "name" | "workspaceName" | "workspacePath" | "remoteWorkspace"
> &
  Pick<TaskRecord, "localWorkspacePath">;

export function workspaceNameFromPath(value: string) {
  const parts = value.trim().split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.trim() || "";
}

function usefulTaskName(task: TaskWorkspaceIdentity) {
  const name = task.name.trim();
  if (!name || name === "新对话" || name === task.remoteWorkspace?.name.trim())
    return "";
  return name;
}

function usefulRemoteRootName(profile: SshRemoteProfile) {
  const name = workspaceNameFromPath(profile.rootPath);
  const normalized = name.toLocaleLowerCase();
  if (
    !name ||
    [".", "~", "home", "root"].includes(normalized) ||
    normalized === profile.username.trim().toLocaleLowerCase()
  )
    return "";
  return name;
}

export function taskWorkspaceName(task: TaskWorkspaceIdentity) {
  const saved = task.workspaceName?.trim();
  if (saved) return saved;
  if (!task.remoteWorkspace)
    return (
      workspaceNameFromPath(task.workspacePath) ||
      usefulTaskName(task) ||
      "工作区"
    );

  return (
    usefulTaskName(task) ||
    usefulRemoteRootName(task.remoteWorkspace) ||
    task.remoteWorkspace.name.trim() ||
    "远程工作区"
  );
}

export function defaultRemoteWorkspaceName(profile: SshRemoteProfile) {
  return usefulRemoteRootName(profile) || profile.name.trim() || "远程工作区";
}

function isSshCachePath(task: TaskWorkspaceIdentity, value: string) {
  const parts = value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase());
  const profileId = task.remoteWorkspace?.id.trim().toLocaleLowerCase();
  const cacheRootIndex = parts.lastIndexOf("ssh-workspaces");
  return Boolean(
    profileId &&
    cacheRootIndex >= 0 &&
    parts[cacheRootIndex + 1] === profileId,
  );
}

/**
 * SSH tasks execute against an app-managed cache, but the user may still have
 * started from a local project. Keep that distinction explicit for UI actions
 * such as opening a project in File Explorer.
 */
export function localWorkspacePath(task: TaskWorkspaceIdentity) {
  const saved = task.localWorkspacePath?.trim();
  if (saved) return saved;
  const path = task.workspacePath.trim();
  if (task.remoteWorkspace && (!path || isSshCachePath(task, path)))
    return undefined;
  return path || undefined;
}

export function attachSshWorkspace(
  task: TaskRecord,
  state: Required<Pick<SshRemoteState, "profile" | "cachePath">>,
  updatedAt = Date.now(),
): TaskRecord {
  const workspaceName = task.workspaceName?.trim()
    ? task.workspaceName.trim()
    : task.remoteWorkspace
      ? taskWorkspaceName(task)
      : workspaceNameFromPath(task.workspacePath) ||
        usefulTaskName(task) ||
        "工作区";
  const projectPath = localWorkspacePath(task);
  return {
    ...task,
    workspaceName,
    localWorkspacePath: projectPath,
    workspacePath: state.cachePath,
    remoteWorkspace: state.profile,
    updatedAt,
  };
}
