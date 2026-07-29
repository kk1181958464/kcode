import type { SidebarTask, SidebarWorkspaceGroup, TaskRecord } from "./models";

export type SidebarProjection = {
  taskQuery: string;
  showArchived: boolean;
  snapshot: readonly SidebarTask[];
  workspaceGroups: SidebarWorkspaceGroup[];
};

function sidebarFieldsMatch(task: TaskRecord, snapshot: SidebarTask) {
  return (
    task.id === snapshot.id &&
    task.name === snapshot.name &&
    task.workspacePath === snapshot.workspacePath &&
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
        workspacePath: task.workspacePath,
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
    const conversations = groups.get(task.workspacePath);
    if (conversations) conversations.push(task);
    else groups.set(task.workspacePath, [task]);
  }

  return {
    taskQuery,
    showArchived,
    snapshot,
    workspaceGroups: [...groups.entries()].map(
      ([workspacePath, conversations]) => ({
        workspacePath,
        name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || "工作区",
        conversations,
      }),
    ),
  };
}
