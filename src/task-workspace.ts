import type { TaskRecord } from "./models";
import type { SshRemoteProfile, SshRemoteState } from "./ssh-remote-types";

type TaskWorkspaceIdentity = Pick<
  TaskRecord,
  "name" | "workspaceName" | "workspacePath" | "remoteWorkspace"
>;

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
  return {
    ...task,
    workspaceName,
    workspacePath: state.cachePath,
    remoteWorkspace: state.profile,
    updatedAt,
  };
}
