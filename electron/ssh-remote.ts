import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  SshRemoteConnectInput,
  SshRemoteEntry,
  SshRemoteFile,
  SshRemoteProfile,
  SshRemoteState,
} from "../src/ssh-remote-types";
import {
  connectSsh,
  disconnectSsh,
  listSshDirectory,
  readSshFile,
  resolveSshRoot,
  sshSessionInfo,
  sshSessionRecovery,
  writeSshFile,
} from "./ssh";
import { resolveSshWorkspacePath } from "./ssh-remote-path";

type SshRemoteSecret = {
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

type StoredSshRemoteProfile = Omit<SshRemoteProfile, "remembered"> & {
  encryptedSecret: string;
};

const profilesPath = () =>
  path.join(app.getPath("userData"), "ssh-remote-profiles.json");
const cacheRoot = () => path.join(app.getPath("userData"), "ssh-workspaces");
const profiles = new Map<string, StoredSshRemoteProfile>();
const runtimeProfiles = new Map<
  string,
  { profile: SshRemoteProfile; secret?: SshRemoteSecret }
>();
const bindings = new Map<string, string>();
const connectionErrors = new Map<string, string>();
const connectingTasks = new Set<string>();
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = JSON.parse(
      await readFile(profilesPath(), "utf8"),
    ) as StoredSshRemoteProfile[];
    for (const profile of stored) profiles.set(profile.id, profile);
  } catch {
    // First use or a manually removed profile file.
  }
}

async function persistProfiles() {
  const target = profilesPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      JSON.stringify([...profiles.values()], null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function encryptSecret(secret: SshRemoteSecret) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("当前系统无法安全保存 SSH 凭据，请关闭“记住连接”后重试。");
  return safeStorage.encryptString(JSON.stringify(secret)).toString("base64");
}

function decryptSecret(profile: StoredSshRemoteProfile) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("当前系统暂时无法解密已保存的 SSH 凭据。");
  return JSON.parse(
    safeStorage.decryptString(Buffer.from(profile.encryptedSecret, "base64")),
  ) as SshRemoteSecret;
}

function publicProfile(profile: StoredSshRemoteProfile): SshRemoteProfile {
  const { encryptedSecret: _encryptedSecret, ...value } = profile;
  return { ...value, remembered: true };
}

function storedProfile(
  profile: SshRemoteProfile,
  encryptedSecret: string,
): StoredSshRemoteProfile {
  const { remembered: _remembered, ...value } = profile;
  return { ...value, encryptedSecret };
}

function normalizeProfileName(input: SshRemoteConnectInput) {
  return (
    input.name?.trim() ||
    `${input.username.trim()}@${input.host.trim()}${input.rootPath?.trim() ? `:${input.rootPath.trim()}` : ""}`
  ).slice(0, 160);
}

async function privateKeyFromInput(input: SshRemoteConnectInput) {
  if (input.privateKey?.trim()) return input.privateKey;
  if (!input.privateKeyPath?.trim()) return undefined;
  try {
    return await readFile(input.privateKeyPath, "utf8");
  } catch {
    throw new Error("无法读取所选 SSH 私钥文件。");
  }
}

function cachePath(profileId: string) {
  return path.join(cacheRoot(), profileId);
}

async function connectWithProfile(
  taskId: string,
  profile: SshRemoteProfile,
  secret: SshRemoteSecret,
) {
  connectingTasks.add(taskId);
  connectionErrors.delete(taskId);
  bindings.delete(taskId);
  const signal = new AbortController().signal;
  try {
    const connection = await connectSsh(
      taskId,
      `ssh-remote:${taskId}`,
      {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password: secret.password,
        privateKey: secret.privateKey,
        passphrase: secret.passphrase,
        hostFingerprint: profile.hostFingerprint,
        rememberForRemoteWorkspace: profile.remembered,
      },
      signal,
    );
    const rootPath = await resolveSshRoot(
      taskId,
      `ssh-remote:${taskId}`,
      profile.rootPath,
      signal,
    );
    const resolvedProfile = {
      ...profile,
      rootPath,
      hostFingerprint: connection.hostFingerprint,
    };
    runtimeProfiles.set(profile.id, {
      profile: resolvedProfile,
      secret,
    });
    bindings.set(taskId, profile.id);
    await mkdir(cachePath(profile.id), { recursive: true });
    return resolvedProfile;
  } catch (error) {
    disconnectSsh(taskId);
    const message = error instanceof Error ? error.message : String(error);
    connectionErrors.set(taskId, message);
    throw error;
  } finally {
    connectingTasks.delete(taskId);
  }
}

export async function listSshRemoteProfiles() {
  await ensureLoaded();
  return [...profiles.values()].map(publicProfile);
}

export async function connectSshRemote(input: SshRemoteConnectInput) {
  await ensureLoaded();
  const profileId = input.profileId?.trim() || randomUUID();
  const previousRuntime = runtimeProfiles.get(profileId);
  const privateKey = await privateKeyFromInput(input);
  const secret: SshRemoteSecret = {
    password: input.authType === "password" ? input.password : undefined,
    privateKey: input.authType === "private-key" ? privateKey : undefined,
    passphrase: input.passphrase,
  };
  const encryptedSecret = input.remember ? encryptSecret(secret) : undefined;
  const profile: SshRemoteProfile = {
    id: profileId,
    name: normalizeProfileName(input),
    host: input.host.trim(),
    port: Number(input.port) || 22,
    username: input.username.trim(),
    rootPath: input.rootPath?.trim() || ".",
    authType: input.authType,
    remembered: Boolean(input.remember),
  };
  const resolved = await connectWithProfile(input.taskId, profile, secret);
  if (encryptedSecret) {
    const previous = profiles.get(profileId);
    profiles.set(profileId, storedProfile(resolved, encryptedSecret));
    try {
      await persistProfiles();
    } catch (error) {
      if (previous) profiles.set(profileId, previous);
      else profiles.delete(profileId);
      disconnectSsh(input.taskId);
      bindings.delete(input.taskId);
      if (previousRuntime) runtimeProfiles.set(profileId, previousRuntime);
      else runtimeProfiles.delete(profileId);
      throw new Error(
        `无法保存 SSH Remote 配置：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return sshRemoteState(input.taskId, profileId);
}

export async function connectSavedSshRemote(taskId: string, profileId: string) {
  await ensureLoaded();
  const runtime = runtimeProfiles.get(profileId);
  if (runtime?.secret)
    await connectWithProfile(taskId, runtime.profile, runtime.secret);
  else {
    const stored = profiles.get(profileId);
    if (!stored) {
      if (runtime)
        throw new Error(
          "此 SSH Remote 来自临时连接，断开后需要重新输入凭据。",
        );
      throw new Error("找不到已保存的 SSH Remote 连接。");
    }
    const resolved = await connectWithProfile(
      taskId,
      publicProfile(stored),
      decryptSecret(stored),
    );
    if (!stored.hostFingerprint && resolved.hostFingerprint) {
      profiles.set(profileId, storedProfile(resolved, stored.encryptedSecret));
      try {
        await persistProfiles();
      } catch (error) {
        profiles.set(profileId, stored);
        disconnectSsh(taskId);
        bindings.delete(taskId);
        runtimeProfiles.delete(profileId);
        throw new Error(
          `无法保存 SSH 主机指纹：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return sshRemoteState(taskId, profileId);
}

export async function sshRemoteState(taskId: string, profileId?: string) {
  await ensureLoaded();
  const id = profileId || bindings.get(taskId);
  const stored = id ? profiles.get(id) : undefined;
  const runtime = id ? runtimeProfiles.get(id) : undefined;
  const profile =
    runtime?.profile ?? (stored ? publicProfile(stored) : undefined);
  const sessionConnected = sshSessionInfo(taskId).connected;
  const bindingMatches = !id || bindings.get(taskId) === id;
  return {
    taskId,
    connected: sessionConnected && bindingMatches,
    connecting: connectingTasks.has(taskId),
    profile,
    cachePath: id ? cachePath(id) : undefined,
    error: connectionErrors.get(taskId),
  } satisfies SshRemoteState;
}

export async function disconnectSshRemote(taskId: string) {
  disconnectSsh(taskId);
  connectionErrors.delete(taskId);
  return sshRemoteState(taskId);
}

export async function adoptActiveSshRemote(
  taskId: string,
  requestedRootPath = "~",
  preferredName?: string,
) {
  await ensureLoaded();
  const session = sshSessionInfo(taskId);
  if (!session.connected)
    throw new Error("当前任务没有可接管的 SSH 连接。");
  const rootPath = await resolveSshRoot(
    taskId,
    `ssh-remote:adopt:${taskId}`,
    requestedRootPath,
    new AbortController().signal,
  );
  const recovery = sshSessionRecovery(taskId);
  const boundProfileId = bindings.get(taskId);
  const boundRuntime = boundProfileId
    ? runtimeProfiles.get(boundProfileId)
    : undefined;
  const boundStored = boundProfileId ? profiles.get(boundProfileId) : undefined;
  const boundProfile =
    boundRuntime?.profile ?? (boundStored ? publicProfile(boundStored) : undefined);
  const sameEndpoint =
    boundProfile?.host === session.host &&
    boundProfile.port === session.port &&
    boundProfile.username === session.username;
  const preferred = preferredName?.trim().toLocaleLowerCase();
  const namedProfiles = preferred
    ? [...profiles.values()].filter(
        (profile) => profile.name.trim().toLocaleLowerCase() === preferred,
      )
    : [];
  const endpointProfiles = [...profiles.values()].filter(
    (profile) =>
      profile.host.trim().toLocaleLowerCase() ===
        session.host.trim().toLocaleLowerCase() &&
      profile.port === session.port &&
      profile.username === session.username,
  );
  const reusableProfileId =
    namedProfiles.length === 1
      ? namedProfiles[0].id
      : endpointProfiles.length === 1
        ? endpointProfiles[0].id
        : undefined;
  const mayReplaceRememberedProfile = Boolean(
    recovery?.rememberForRemoteWorkspace && recovery.secret,
  );
  const mayReuseBoundProfile = Boolean(
    sameEndpoint &&
      boundProfileId &&
      (!boundStored || mayReplaceRememberedProfile),
  );
  const profileId =
    mayReuseBoundProfile && boundProfileId
      ? boundProfileId
      : mayReplaceRememberedProfile && reusableProfileId
        ? reusableProfileId
        : randomUUID();
  const runtime = runtimeProfiles.get(profileId);
  const stored = profiles.get(profileId);
  const secret = recovery?.secret ?? runtime?.secret;
  const previousProfile =
    runtime?.profile ?? (stored ? publicProfile(stored) : undefined);
  let encryptedSecret: string | undefined;
  if (recovery?.rememberForRemoteWorkspace && secret) {
    try {
      encryptedSecret = encryptSecret(secret);
    } catch {
      // The active session remains usable when secure persistence is unavailable.
    }
  }
  let profile: SshRemoteProfile = {
    id: profileId,
    name:
      preferredName?.trim().slice(0, 160) ||
      previousProfile?.name ||
      `${session.username}@${session.host}`,
    host: session.host,
    port: session.port,
    username: session.username,
    rootPath,
    authType: session.authType,
    hostFingerprint: session.hostFingerprint,
    remembered: Boolean(encryptedSecret),
  };
  runtimeProfiles.set(profileId, {
    profile,
    secret,
  });
  bindings.set(taskId, profileId);
  connectionErrors.delete(taskId);
  await mkdir(cachePath(profileId), { recursive: true });
  if (encryptedSecret) {
    const previousStored = profiles.get(profileId);
    profiles.set(profileId, storedProfile(profile, encryptedSecret));
    try {
      await persistProfiles();
    } catch {
      if (previousStored) profiles.set(profileId, previousStored);
      else profiles.delete(profileId);
      profile = { ...profile, remembered: Boolean(previousStored) };
      runtimeProfiles.set(profileId, { profile, secret });
    }
  }
  return sshRemoteState(taskId, profileId);
}

export async function forgetSshRemoteProfile(profileId: string) {
  await ensureLoaded();
  for (const [taskId, boundProfileId] of bindings)
    if (boundProfileId === profileId) {
      disconnectSsh(taskId);
      bindings.delete(taskId);
      connectionErrors.set(taskId, "已删除此任务使用的 SSH Remote 连接。");
    }
  profiles.delete(profileId);
  runtimeProfiles.delete(profileId);
  await persistProfiles();
  return listSshRemoteProfiles();
}

async function profileForTask(taskId: string, profileId: string) {
  let state = await sshRemoteState(taskId, profileId);
  if (!state.connected) state = await connectSavedSshRemote(taskId, profileId);
  if (!state.profile) throw new Error("SSH Remote 配置不存在。");
  return state.profile;
}

export async function listSshRemoteDirectory(
  taskId: string,
  profileId: string,
  requestedPath?: string,
) {
  const profile = await profileForTask(taskId, profileId);
  const remotePath = resolveSshWorkspacePath(
    profile.rootPath,
    requestedPath,
    profile.rootPath,
  );
  const entries = await listSshDirectory(
    taskId,
    `ssh-editor:${taskId}`,
    remotePath,
    new AbortController().signal,
  );
  return entries
    .filter((entry) => entry.name !== "." && entry.name !== "..")
    .map((entry) => ({
      ...entry,
      path: path.posix.join(remotePath, entry.name),
    }))
    .sort((left, right) => {
      if (left.type === right.type)
        return left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        });
      if (left.type === "directory") return -1;
      if (right.type === "directory") return 1;
      return left.type === "file" ? -1 : 1;
    }) satisfies SshRemoteEntry[];
}

export async function readSshRemoteFile(
  taskId: string,
  profileId: string,
  requestedPath: string,
) {
  const profile = await profileForTask(taskId, profileId);
  const remotePath = resolveSshWorkspacePath(profile.rootPath, requestedPath);
  const content = await readSshFile(
    taskId,
    `ssh-editor:${taskId}`,
    remotePath,
    new AbortController().signal,
  );
  return {
    path: remotePath,
    content,
    size: Buffer.byteLength(content),
    modifiedAt: Date.now(),
  } satisfies SshRemoteFile;
}

export async function writeSshRemoteFile(
  taskId: string,
  profileId: string,
  requestedPath: string,
  content: string,
  expectedContent?: string | null,
) {
  const profile = await profileForTask(taskId, profileId);
  const remotePath = resolveSshWorkspacePath(profile.rootPath, requestedPath);
  const result = await writeSshFile(
    taskId,
    `ssh-editor:${taskId}`,
    undefined,
    remotePath,
    content,
    new AbortController().signal,
    expectedContent,
  );
  return {
    path: remotePath,
    content,
    size: result.bytes,
    modifiedAt: Date.now(),
  } satisfies SshRemoteFile;
}
