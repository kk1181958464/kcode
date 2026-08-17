export type SshRemoteAuthType = "password" | "private-key";

export type SshRemoteProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  rootPath: string;
  authType: SshRemoteAuthType;
  hostFingerprint?: string;
  remembered: boolean;
};

export type SshRemoteWorkspace = SshRemoteProfile;

export type SshRemoteConnectInput = {
  taskId: string;
  profileId?: string;
  name?: string;
  host: string;
  port?: number;
  username: string;
  rootPath?: string;
  authType: SshRemoteAuthType;
  password?: string;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  remember?: boolean;
};

export type SshRemoteState = {
  taskId: string;
  connected: boolean;
  connecting: boolean;
  reconnectAvailable?: boolean;
  profile?: SshRemoteProfile;
  cachePath?: string;
  error?: string;
};

export type SshRemoteEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  modifiedAt: number;
  mode: number;
};

export type SshRemoteFile = {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
};
