// Small localStorage-backed UI preferences shared by App and its hooks.

const COLLAPSED_WORKSPACES_KEY = "kcode.collapsedWorkspaces";
const TASK_DRAFTS_KEY = "kcode.taskDrafts";

export function readCollapsedWorkspaces(): Set<string> {
  try {
    return new Set(
      JSON.parse(
        localStorage.getItem(COLLAPSED_WORKSPACES_KEY) || "[]",
      ) as string[],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedWorkspaces(keys: ReadonlySet<string>) {
  localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify([...keys]));
}

export function writeStoredTaskDrafts(drafts: Record<string, string>) {
  localStorage.setItem(TASK_DRAFTS_KEY, JSON.stringify(drafts));
}
