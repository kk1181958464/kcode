import type { AgentActivity } from "./types";

export function sshWorkspaceRootFromActivity(
  activity: Pick<AgentActivity, "tool" | "status" | "path">,
) {
  if (
    activity.status !== "success" ||
    (activity.tool !== "ssh_connect" &&
      activity.tool !== "ssh_set_workspace")
  )
    return undefined;
  return activity.path?.trim() || undefined;
}
