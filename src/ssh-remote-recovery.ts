import type {
  SshRemoteProfile,
  SshRemoteState,
  SshRemoteWorkspace,
} from "./ssh-remote-types";

type SshRemoteRecoveryApi = {
  profiles(): Promise<SshRemoteProfile[]>;
  state(taskId: string, profileId?: string): Promise<SshRemoteState>;
  connectSaved(taskId: string, profileId: string): Promise<SshRemoteState>;
};

function normalizedHost(value: string) {
  return value.trim().toLocaleLowerCase();
}

function normalizedRoot(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function sameEndpoint(
  left: Pick<SshRemoteProfile, "host" | "port" | "username">,
  right: Pick<SshRemoteProfile, "host" | "port" | "username">,
) {
  return (
    normalizedHost(left.host) === normalizedHost(right.host) &&
    left.port === right.port &&
    left.username.trim() === right.username.trim()
  );
}

export function matchingSavedSshRemoteProfile(
  workspace: SshRemoteWorkspace,
  profiles: SshRemoteProfile[],
) {
  const byId = profiles.find((profile) => profile.id === workspace.id);
  if (byId) return byId;

  const endpointMatches = profiles.filter((profile) =>
    sameEndpoint(profile, workspace),
  );
  const rootMatches = endpointMatches.filter(
    (profile) =>
      normalizedRoot(profile.rootPath) === normalizedRoot(workspace.rootPath),
  );
  if (rootMatches.length === 1) return rootMatches[0];
  if (endpointMatches.length === 1) return endpointMatches[0];
  return undefined;
}

export class SshRemoteCredentialsRequiredError extends Error {
  readonly code = "ssh_remote_credentials_required";

  constructor(readonly workspace: SshRemoteWorkspace) {
    super(
      `未找到 ${workspace.username}@${workspace.host}:${workspace.port} 的可恢复凭据，请重新选择密码或私钥。`,
    );
    this.name = "SshRemoteCredentialsRequiredError";
  }
}

export function isSshRemoteCredentialsRequired(error: unknown) {
  return error instanceof SshRemoteCredentialsRequiredError;
}

export async function restoreSshRemoteConnection(
  api: SshRemoteRecoveryApi,
  taskId: string,
  workspace: SshRemoteWorkspace,
) {
  const current = await api.state(taskId, workspace.id);
  if (current.connected) return current;

  if (current.profile && current.reconnectAvailable)
    return api.connectSaved(taskId, current.profile.id);

  const candidate = matchingSavedSshRemoteProfile(
    workspace,
    await api.profiles(),
  );
  if (candidate) return api.connectSaved(taskId, candidate.id);
  throw new SshRemoteCredentialsRequiredError(workspace);
}
