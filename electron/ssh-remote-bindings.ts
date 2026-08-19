import type { SshRemoteProfile } from "../src/ssh-remote-types";

export class SshRemoteTaskWorkspaceBindings {
  private readonly workspaces = new Map<string, SshRemoteProfile>();

  bind(taskId: string, workspace: SshRemoteProfile) {
    this.workspaces.set(taskId, { ...workspace });
  }

  unbind(taskId: string) {
    this.workspaces.delete(taskId);
  }

  profileId(taskId: string) {
    return this.workspaces.get(taskId)?.id;
  }

  workspace(taskId: string, profileId?: string) {
    const workspace = this.workspaces.get(taskId);
    if (!workspace || (profileId && workspace.id !== profileId)) return undefined;
    return { ...workspace };
  }

  removeProfile(profileId: string) {
    const taskIds: string[] = [];
    for (const [taskId, workspace] of this.workspaces) {
      if (workspace.id !== profileId) continue;
      this.workspaces.delete(taskId);
      taskIds.push(taskId);
    }
    return taskIds;
  }
}
