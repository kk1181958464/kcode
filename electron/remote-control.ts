import { app, BrowserWindow, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  RemoteCommand,
  RemoteCommandEnvelope,
  RemoteControlState,
  RemoteProvider,
  RemoteTaskStreamEvent,
  RemoteTaskSnapshot,
} from "../src/remote-types";
import { exportProviderVault, importProviderVault } from "./store";

type RemotePersisted = {
  serverUrl: string;
  username?: string;
  encryptedToken?: string;
  deviceId: string;
  deviceName: string;
  enabled: boolean;
};

type RemoteCallbacks = {
  onState(state: RemoteControlState): void;
  onCommand(envelope: RemoteCommandEnvelope): void;
};

const defaultServerUrl = () =>
  (process.env.KCODE_REMOTE_URL || "https://kcode.98104.cn").replace(/\/$/, "");
const configPath = () =>
  path.join(app.getPath("userData"), "remote-control.json");
const defaultPersisted = (): RemotePersisted => ({
  serverUrl: defaultServerUrl(),
  deviceId: randomUUID(),
  deviceName: `${process.platform === "win32" ? "Windows" : process.platform} · KCode`,
  enabled: false,
});

let persisted = defaultPersisted();
let loaded = false;
let callbacks: RemoteCallbacks | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1_000;
let stopped = false;
let pendingTasks: RemoteTaskSnapshot[] | undefined;
let lastSyncedAt: number | undefined;
const pendingResults: Array<{ id: string; ok: boolean; error?: string }> = [];
const MAX_PENDING_RESULTS = 200;

function stateFromPersisted(error?: string): RemoteControlState {
  return {
    configured: Boolean(persisted.username && persisted.encryptedToken),
    enabled: persisted.enabled,
    connected: socket?.readyState === WebSocket.OPEN,
    serverUrl: persisted.serverUrl,
    username: persisted.username,
    deviceId: persisted.deviceId,
    deviceName: persisted.deviceName,
    lastSyncedAt,
    error,
  };
}

let lastState: RemoteControlState = stateFromPersisted();

function publishState(error?: string) {
  lastState = stateFromPersisted(error);
  callbacks?.onState(lastState);
}

async function readPersisted() {
  try {
    const value = JSON.parse(
      await readFile(configPath(), "utf8"),
    ) as Partial<RemotePersisted>;
    persisted = { ...defaultPersisted(), ...value };
  } catch {
    persisted = defaultPersisted();
  }
  loaded = true;
  publishState();
}

async function writePersisted() {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(persisted, null, 2), "utf8");
}

function token() {
  if (!persisted.encryptedToken) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(
      Buffer.from(persisted.encryptedToken, "base64"),
    );
  } catch {
    return undefined;
  }
}

function validateServerUrl(input: string) {
  const value = input.trim().replace(/\/$/, "");
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  )
    throw new Error("远程控制服务必须使用 HTTPS");
  if (url.pathname !== "/") throw new Error("远程服务地址不能包含路径");
  return value;
}

async function remoteFetch<T>(pathName: string, init: RequestInit = {}) {
  const accessToken = token();
  if (!accessToken) throw new Error("尚未登录远程控制");
  const response = await fetch(`${persisted.serverUrl}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) throw new Error(body.error || "远程服务请求失败");
  return body;
}

function websocketUrl() {
  const url = new URL(persisted.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams({
    deviceId: persisted.deviceId,
    name: persisted.deviceName,
    platform: process.platform,
    version: app.getVersion(),
  }).toString();
  return url.toString();
}

function sendSocket(value: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function scheduleReconnect() {
  if (stopped || !persisted.enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(30_000, reconnectDelay * 1.8);
}

async function connect() {
  if (!loaded || stopped || !persisted.enabled || !token()) {
    publishState();
    return;
  }
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  const accessToken = token();
  if (!accessToken) return;
  try {
    socket = new WebSocket(websocketUrl(), [
      "kcode-v1",
      `kcode-token.${accessToken}`,
    ]);
  } catch (error) {
    publishState(error instanceof Error ? error.message : "远程连接失败");
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    reconnectDelay = 1_000;
    publishState();
    if (pendingTasks) {
      sendSocket({ type: "tasks.replace", tasks: pendingTasks });
      pendingTasks = undefined;
    }
    for (const result of pendingResults.splice(0))
      sendSocket({ type: "command.result", ...result });
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "command") {
        if (
          typeof message.id === "string" &&
          message.command &&
          typeof message.command === "object"
        )
          callbacks?.onCommand({
            id: message.id,
            command: message.command as RemoteCommand,
          });
      } else if (message.type === "session.ready") {
        publishState();
      } else if (message.type === "error") {
        publishState(
          typeof message.message === "string"
            ? message.message
            : "远程服务返回错误",
        );
      }
    } catch (error) {
      publishState(error instanceof Error ? error.message : "远程消息格式无效");
    }
  });
  socket.addEventListener("close", () => {
    socket = undefined;
    publishState();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    publishState("远程连接暂时不可用");
  });
}

export async function initializeRemoteControl(next: RemoteCallbacks) {
  callbacks = next;
  stopped = false;
  await readPersisted();
  if (persisted.enabled && token()) void connect();
}

export function remoteState() {
  return lastState;
}

export async function remoteRegister(
  serverUrl: string,
  username: string,
  password: string,
) {
  await ensureLoaded();
  persisted.serverUrl = validateServerUrl(serverUrl);
  const response = await fetch(`${persisted.serverUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, clientType: "desktop" }),
  });
  return finishLogin(response, username);
}

export async function remoteLogin(
  serverUrl: string,
  username: string,
  password: string,
) {
  await ensureLoaded();
  persisted.serverUrl = validateServerUrl(serverUrl);
  const response = await fetch(`${persisted.serverUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, clientType: "desktop" }),
  });
  return finishLogin(response, username);
}

async function finishLogin(response: Response, username: string) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    token?: string;
  };
  if (!response.ok || !body.token)
    throw new Error(body.error || "远程登录失败");
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("当前系统无法安全保存远程登录凭据");
  persisted.username = username.trim().toLowerCase();
  persisted.encryptedToken = safeStorage
    .encryptString(body.token)
    .toString("base64");
  persisted.enabled = true;
  stopped = false;
  await writePersisted();
  publishState();
  await syncProviderVault();
  void connect();
  return lastState;
}

async function ensureLoaded() {
  if (!loaded) await readPersisted();
}

export async function remoteLogout() {
  await ensureLoaded();
  try {
    if (token()) await remoteFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Local logout must still work when the server is unavailable.
  }
  persisted.username = undefined;
  persisted.encryptedToken = undefined;
  persisted.enabled = false;
  await writePersisted();
  closeRemoteConnection();
  publishState();
}

export async function setRemoteEnabled(enabled: boolean) {
  await ensureLoaded();
  persisted.enabled = enabled;
  await writePersisted();
  if (enabled) {
    stopped = false;
    void connect();
  } else closeRemoteConnection();
  publishState();
}

export function closeRemoteConnection() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  socket = undefined;
}

export async function syncRemoteTasks(tasks: RemoteTaskSnapshot[]) {
  await ensureLoaded();
  if (!persisted.enabled || !token()) {
    pendingTasks = undefined;
    return;
  }
  pendingTasks = tasks;
  if (!sendSocket({ type: "tasks.replace", tasks })) publishState();
  else {
    lastSyncedAt = Date.now();
    lastState = { ...lastState, lastSyncedAt, error: undefined };
    callbacks?.onState(lastState);
  }
}

export async function syncRemoteTaskEvent(event: RemoteTaskStreamEvent) {
  await ensureLoaded();
  if (!persisted.enabled || !token()) return;
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024)
    throw new Error("远程实时事件超过 512 KB 限制");
  sendSocket(event);
}

export function remoteCommandResult(id: string, ok: boolean, error?: string) {
  const message = { type: "command.result", id, ok, error };
  if (!sendSocket(message)) {
    pendingResults.push({ id, ok, error });
    if (pendingResults.length > MAX_PENDING_RESULTS) pendingResults.shift();
  }
}

export async function syncProviderVault() {
  await ensureLoaded();
  if (!persisted.enabled || !token()) return;
  const local = await exportProviderVault();
  const remote = await remoteFetch<{
    configured: boolean;
    config?: { providers?: RemoteProvider[] };
  }>("/api/config");
  if (!remote.configured || !remote.config?.providers?.length) {
    await remoteFetch("/api/config", {
      method: "PUT",
      body: JSON.stringify({ providers: local }),
    });
    return;
  }
  await importProviderVault(remote.config.providers);
}

export async function uploadProviderVault() {
  await ensureLoaded();
  if (!persisted.enabled || !token()) return;
  await remoteFetch("/api/config", {
    method: "PUT",
    body: JSON.stringify({ providers: await exportProviderVault() }),
  });
}

export function remoteShouldKeepRunning() {
  return persisted.enabled && Boolean(persisted.encryptedToken);
}
