import type { SidebarTask, SidebarWorkspaceGroup, TaskRecord } from "./models";
import { taskWorkspaceName } from "./task-workspace";

export type SidebarProjection = {
  taskQuery: string;
  showArchived: boolean;
  snapshot: readonly SidebarTask[];
  workspaceGroups: SidebarWorkspaceGroup[];
};

export function sidebarTaskRenderKey(task: SidebarTask) {
  return `task:${task.id}`;
}

type SidebarWorkspaceIdentity = Pick<
  SidebarTask,
  "name" | "workspaceName" | "workspacePath" | "remoteWorkspace"
>;

function normalizedRemoteRoot(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || ".";
}

/** Keep reused SSH connections separated by project root and workspace. */
export function sidebarWorkspaceKey(task: SidebarWorkspaceIdentity) {
  if (!task.remoteWorkspace) return task.workspacePath;
  const workspaceLabel = task.workspaceName?.trim() || taskWorkspaceName(task);
  return [
    "ssh",
    task.remoteWorkspace.id,
    normalizedRemoteRoot(task.remoteWorkspace.rootPath),
    workspaceLabel,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function sidebarFieldsMatch(task: TaskRecord, snapshot: SidebarTask) {
  return (
    task.id === snapshot.id &&
    task.name === snapshot.name &&
    task.workspaceName === snapshot.workspaceName &&
    task.workspacePath === snapshot.workspacePath &&
    sidebarWorkspaceKey(task) === sidebarWorkspaceKey(snapshot) &&
    Boolean(task.archived) === Boolean(snapshot.archived) &&
    task.runningId === snapshot.runningId &&
    task.runStatus === snapshot.runStatus
  );
}

/**
 * Keep the sidebar detached from large message/activity updates. The App task
 * records can change frequently while an agent runs, but the projection only
 * publishes a new identity when a field visible in the sidebar changes.
 */
export function projectSidebarWorkspaceGroups(
  tasks: readonly TaskRecord[],
  taskQuery: string,
  showArchived: boolean,
  previous?: SidebarProjection,
): SidebarProjection {
  const snapshotUnchanged =
    previous?.snapshot.length === tasks.length &&
    tasks.every((task, index) =>
      sidebarFieldsMatch(task, previous.snapshot[index]),
    );
  if (
    snapshotUnchanged &&
    previous.taskQuery === taskQuery &&
    previous.showArchived === showArchived
  )
    return previous;

  const snapshot: readonly SidebarTask[] = snapshotUnchanged
    ? previous.snapshot
    : tasks.map((task) => ({
        id: task.id,
        name: task.name,
        workspaceName: task.workspaceName,
        workspacePath: task.workspacePath,
        remoteWorkspace: task.remoteWorkspace,
        archived: Boolean(task.archived),
        runningId: task.runningId,
        runStatus: task.runStatus,
      }));
  const query = taskQuery.trim().toLocaleLowerCase();
  const groups = new Map<string, SidebarTask[]>();
  for (const task of snapshot) {
    if (Boolean(task.archived) !== showArchived) continue;
    if (
      query &&
      !`${task.name} ${task.workspacePath}`.toLocaleLowerCase().includes(query)
    )
      continue;
    const workspaceKey = sidebarWorkspaceKey(task);
    const conversations = groups.get(workspaceKey);
    if (conversations) conversations.push(task);
    else groups.set(workspaceKey, [task]);
  }

  return {
    taskQuery,
    showArchived,
    snapshot,
    workspaceGroups: [...groups.entries()].map(
      ([workspaceKey, conversations]) => {
        const remote = conversations[0]?.remoteWorkspace;
        const unassigned = workspaceKey === "" && !remote;
        return {
          key: workspaceKey,
          workspacePath: conversations[0]?.workspacePath ?? "",
          name: unassigned
            ? "未分配工作区"
            : conversations[0]
              ? taskWorkspaceName(conversations[0])
              : "工作区",
          conversations,
          remote: Boolean(remote),
          unassigned,
        };
      },
    ),
  };
}
