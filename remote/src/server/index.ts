import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  createSessionToken,
  hashPassword,
  normalizeUsername,
  tokenHash,
  validatePassword,
  verifyPassword,
} from "./auth.js";
import { RemoteDatabase, type SessionRow } from "./database.js";
import { LiveStreamCache } from "./live-stream-cache.js";
import {
  isRecord,
  parseClientType,
  parseRemoteCommand,
  parseRemoteTaskEvent,
  parseTaskSnapshots,
  remoteCommandAuditPayload,
  stringValue,
  type ClientType,
  type RemoteCommand,
} from "./protocol.js";
import { dataKey, decryptJson, encryptJson } from "./vault.js";

const HOST = process.env.KCODE_HOST || "0.0.0.0";
const PORT = Number(process.env.KCODE_PORT || 8787);
const DATABASE_PATH = process.env.KCODE_DATABASE || "/data/kcode-remote.sqlite";
const PUBLIC_ORIGIN = process.env.KCODE_PUBLIC_ORIGIN?.replace(/\/$/, "");
const RELEASE = process.env.KCODE_RELEASE || "0.1.0";
const SESSION_DAYS = Math.min(
  90,
  Math.max(1, Number(process.env.KCODE_SESSION_DAYS || 30)),
);
const ALLOW_REGISTRATION = process.env.KCODE_ALLOW_REGISTRATION === "true";
const REGISTRATION_SETTING = "registration_open";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = process.env.KCODE_PUBLIC_DIRECTORY
  ? path.resolve(process.env.KCODE_PUBLIC_DIRECTORY)
  : path.resolve(__dirname, "../public");
const startedAt = Date.now();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AuthenticatedSession = SessionRow & { tokenHash: string };
type SocketClient = {
  socket: WebSocket;
  session: AuthenticatedSession;
  deviceId?: string;
  alive: boolean;
};

const encryptionKey = dataKey(process.env.KCODE_DATA_KEY);
const database = new RemoteDatabase(DATABASE_PATH, {
  encode: (value) => encryptJson(value, encryptionKey),
  decode: <T>(value: string) => decryptJson<T>(value, encryptionKey),
});
const clients = new Set<SocketClient>();
const desktops = new Map<string, SocketClient>();
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const liveStreams = new LiveStreamCache();

function deviceKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

function securityHeaders(response: ServerResponse) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (PUBLIC_ORIGIN?.startsWith("https://"))
    response.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
}

function json(response: ServerResponse, status: number, value: unknown) {
  securityHeaders(response);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function errorResponse(response: ServerResponse, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  const message =
    error instanceof Error && status < 500
      ? error.message
      : "服务器暂时无法处理该请求";
  if (status >= 500) console.error(error);
  json(response, status, { error: message });
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "请求内容过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "请求 JSON 格式无效");
  }
}

function cookies(request: IncomingMessage) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function protocolToken(request: IncomingMessage) {
  return (request.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("kcode-token."))
    ?.slice("kcode-token.".length);
}

function rawToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer "))
    return authorization.slice(7).trim();
  return protocolToken(request) || cookies(request).kcode_session;
}

function authenticate(
  request: IncomingMessage,
): AuthenticatedSession | undefined {
  const token = rawToken(request);
  if (!token || token.length > 256) return undefined;
  const hashed = tokenHash(token);
  const session = database.session(hashed, Date.now());
  return session ? { ...session, tokenHash: hashed } : undefined;
}

function requireSession(
  request: IncomingMessage,
  clientType?: ClientType,
): AuthenticatedSession {
  const session = authenticate(request);
  if (!session) throw new HttpError(401, "请先登录");
  if (clientType && session.clientType !== clientType)
    throw new HttpError(403, "当前客户端无权执行该操作");
  return session;
}

function requireAdministrator(request: IncomingMessage) {
  const session = requireSession(request);
  if (!session.isAdmin) throw new HttpError(403, "当前账号不是管理员");
  return session;
}

function sessionCookie(token: string, maxAgeSeconds: number) {
  return [
    `kcode_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    ...(PUBLIC_ORIGIN?.startsWith("https://") ? ["Secure"] : []),
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function remoteAddress(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];
  return (
    (typeof forwarded === "string" ? forwarded.split(",")[0] : undefined) ||
    request.socket.remoteAddress ||
    "unknown"
  ).trim();
}

function enforceAuthRateLimit(request: IncomingMessage, username: string) {
  const now = Date.now();
  const key = `${remoteAddress(request)}:${username}`;
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > 10)
    throw new HttpError(429, "登录尝试过多，请 15 分钟后再试");
}

function clearAuthRateLimit(request: IncomingMessage, username: string) {
  authAttempts.delete(`${remoteAddress(request)}:${username}`);
}

function verifyOrigin(request: IncomingMessage) {
  if (!PUBLIC_ORIGIN || !request.headers.origin) return;
  if (request.headers.origin !== PUBLIC_ORIGIN)
    throw new HttpError(403, "请求来源无效");
}

function createLoginSession(
  response: ServerResponse,
  user: { id: string; username: string },
  clientType: ClientType,
) {
  const token = createSessionToken();
  const now = Date.now();
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  database.createSession({
    tokenHash: tokenHash(token),
    userId: user.id,
    clientType,
    expiresAt: now + maxAge * 1000,
    now,
  });
  if (clientType === "mobile")
    response.setHeader("Set-Cookie", sessionCookie(token, maxAge));
  return {
    user: { id: user.id, username: user.username },
    ...(clientType === "desktop" ? { token } : {}),
  };
}

function registrationOpen() {
  if (database.userCount() === 0) return true;
  const setting = database.setting(REGISTRATION_SETTING);
  return setting === undefined ? ALLOW_REGISTRATION : setting === "true";
}

function authInput(body: Record<string, unknown>) {
  try {
    return {
      username: normalizeUsername(body.username),
      password: validatePassword(body.password),
      clientType: parseClientType(body.clientType),
    };
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "账号登录参数无效",
    );
  }
}

function databaseStorageBytes() {
  let total = 0;
  for (const file of [
    DATABASE_PATH,
    `${DATABASE_PATH}-wal`,
    `${DATABASE_PATH}-shm`,
  ])
    if (existsSync(file)) total += statSync(file).size;
  return total;
}

function liveConnections() {
  let mobile = 0;
  let desktop = 0;
  for (const client of clients)
    if (client.session.clientType === "desktop") desktop += 1;
    else mobile += 1;
  return { total: clients.size, desktop, mobile };
}

function contentType(file: string) {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[extension] || "application/octet-stream"
  );
}

function staticFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "路径格式无效");
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let file = path.resolve(PUBLIC_DIRECTORY, requested);
  const relative = path.relative(PUBLIC_DIRECTORY, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new HttpError(404, "页面不存在");
  if (!existsSync(file) || !statSync(file).isFile())
    file = path.join(PUBLIC_DIRECTORY, "index.html");
  if (!existsSync(file)) throw new HttpError(404, "页面不存在");
  securityHeaders(response);
  const relativeFile = path
    .relative(PUBLIC_DIRECTORY, file)
    .replaceAll("\\", "/");
  const immutableAsset =
    relativeFile.startsWith("assets/") &&
    /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(relativeFile);
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Cache-Control": file.endsWith("index.html")
      ? "no-store, must-revalidate"
      : immutableAsset
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600, must-revalidate",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
  return true;
}

function socketSend(socket: WebSocket, value: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function broadcastMobile(userId: string, value: unknown) {
  for (const client of clients)
    if (
      client.session.userId === userId &&
      client.session.clientType === "mobile"
    )
      socketSend(client.socket, value);
}

function onlineDevices(userId: string) {
  return database.listDevices(userId).map((device) => ({
    ...device,
    online: Boolean(device.online),
  }));
}

function publishDevices(userId: string) {
  broadcastMobile(userId, {
    type: "devices.changed",
    devices: onlineDevices(userId),
  });
}

function routeCommand(
  session: AuthenticatedSession,
  deviceId: string,
  command: RemoteCommand,
  commandId: string = randomUUID(),
) {
  const desktop = desktops.get(deviceKey(session.userId, deviceId));
  if (!desktop || desktop.socket.readyState !== WebSocket.OPEN)
    throw new HttpError(409, "目标电脑当前不在线");
  const now = Date.now();
  database.createCommand({
    id: commandId,
    userId: session.userId,
    deviceId,
    payload: remoteCommandAuditPayload(command),
    now,
  });
  socketSend(desktop.socket, { type: "command", id: commandId, command });
  return commandId;
}

async function api(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) {
  const method = request.method || "GET";
  if (method !== "GET" && method !== "HEAD") verifyOrigin(request);

  if (method === "GET" && url.pathname === "/api/health") {
    json(response, 200, {
      ok: true,
      release: RELEASE,
      registrationOpen: registrationOpen(),
      time: Date.now(),
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/register") {
    if (!registrationOpen())
      throw new HttpError(403, "当前服务器已关闭新账号注册");
    const body = await requestBody(request);
    const { username, password, clientType } = authInput(body);
    enforceAuthRateLimit(request, username);
    if (database.findUser(username)) throw new HttpError(409, "账号已存在");
    const passwordRecord = await hashPassword(password);
    if (!registrationOpen())
      throw new HttpError(403, "当前服务器已关闭新账号注册");
    const user = { id: randomUUID(), username };
    const isFirstUser = database.userCount() === 0;
    try {
      database.createUser({
        ...user,
        password_hash: passwordRecord.hash,
        password_salt: passwordRecord.salt,
        created_at: Date.now(),
        is_admin: isFirstUser ? 1 : 0,
      });
    } catch {
      throw new HttpError(409, "账号已存在");
    }
    clearAuthRateLimit(request, username);
    json(response, 201, createLoginSession(response, user, clientType));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await requestBody(request);
    const { username, password, clientType } = authInput(body);
    enforceAuthRateLimit(request, username);
    const user = database.findUser(username);
    if (
      !user ||
      !(await verifyPassword(password, user.password_salt, user.password_hash))
    )
      throw new HttpError(401, "账号或密码错误");
    clearAuthRateLimit(request, username);
    json(response, 200, createLoginSession(response, user, clientType));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const session = requireSession(request);
    database.revokeSession(session.tokenHash);
    response.setHeader("Set-Cookie", sessionCookie("", 0));
    json(response, 200, { ok: true });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/session") {
    const session = requireSession(request);
    json(response, 200, {
      user: { id: session.userId, username: session.username },
      clientType: session.clientType,
      isAdmin: session.isAdmin,
      registrationOpen: registrationOpen(),
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/admin/session") {
    const session = requireAdministrator(request);
    json(response, 200, {
      user: { id: session.userId, username: session.username },
      release: RELEASE,
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/admin/overview") {
    const session = requireAdministrator(request);
    const now = Date.now();
    database.cleanExpiredSessions(now);
    json(response, 200, {
      viewer: { id: session.userId, username: session.username },
      service: {
        ok: true,
        release: RELEASE,
        startedAt,
        uptimeMs: now - startedAt,
        serverTime: now,
        registrationOpen: registrationOpen(),
        databaseBytes: databaseStorageBytes(),
        connections: liveConnections(),
      },
      totals: database.adminOverview(now),
      users: database.listAdminUsers(now),
      devices: database.listAdminDevices(),
      commands: database.listAdminCommands(40),
    });
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/admin/settings") {
    requireAdministrator(request);
    const body = await requestBody(request);
    if (typeof body.registrationOpen !== "boolean")
      throw new HttpError(400, "账号注册设置无效");
    database.saveSetting(
      REGISTRATION_SETTING,
      body.registrationOpen ? "true" : "false",
      Date.now(),
    );
    json(response, 200, { registrationOpen: registrationOpen() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/devices") {
    const session = requireSession(request);
    json(response, 200, { devices: onlineDevices(session.userId) });
    return true;
  }

  const tasksMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/tasks$/);
  if (method === "GET" && tasksMatch) {
    const session = requireSession(request);
    const deviceId = stringValue(decodeURIComponent(tasksMatch[1]), "设备 ID");
    if (
      !database.listDevices(session.userId).some((item) => item.id === deviceId)
    )
      throw new HttpError(404, "设备不存在");
    json(response, 200, {
      tasks: database.listTasks(session.userId, deviceId),
      streams: liveStreams.list(session.userId, deviceId),
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    const session = requireSession(request, "desktop");
    const stored = database.config(session.userId);
    json(response, 200, {
      configured: Boolean(stored),
      updatedAt: stored?.updatedAt,
      config: stored
        ? decryptJson(stored.ciphertext, encryptionKey)
        : undefined,
    });
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const session = requireSession(request, "desktop");
    const body = await requestBody(request);
    if (!Array.isArray(body.providers) || body.providers.length > 100)
      throw new HttpError(400, "模型配置格式无效");
    const serialized = JSON.stringify(body.providers);
    if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024)
      throw new HttpError(413, "模型配置超过 2 MB 限制");
    const now = Date.now();
    database.saveConfig(
      session.userId,
      encryptJson({ providers: body.providers }, encryptionKey),
      now,
    );
    json(response, 200, { ok: true, updatedAt: now });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/commands") {
    const session = requireSession(request, "mobile");
    const body = await requestBody(request);
    const deviceId = stringValue(body.deviceId, "设备 ID");
    const command = parseRemoteCommand(body.command);
    const id = routeCommand(
      session,
      deviceId,
      command,
      body.id === undefined ? randomUUID() : stringValue(body.id, "命令 ID"),
    );
    json(response, 202, { id, status: "sent" });
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (url.pathname.startsWith("/api/")) {
      if (!(await api(request, response, url)))
        throw new HttpError(404, "接口不存在");
      return;
    }
    staticFile(request, response, url);
  } catch (error) {
    errorResponse(response, error);
  }
});

const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_BODY_BYTES,
  handleProtocols(protocols) {
    return protocols.has("kcode-v1") ? "kcode-v1" : false;
  },
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (url.pathname !== "/ws") throw new HttpError(404, "连接地址不存在");
    verifyOrigin(request);
    const session = requireSession(request);
    (
      request as IncomingMessage & { remoteSession?: AuthenticatedSession }
    ).remoteSession = session;
    websocketServer.handleUpgrade(request, socket, head, (websocket) =>
      websocketServer.emit("connection", websocket, request),
    );
  } catch {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

websocketServer.on("connection", (socket, request) => {
  const session = (
    request as IncomingMessage & { remoteSession: AuthenticatedSession }
  ).remoteSession;
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  const client: SocketClient = { socket, session, alive: true };
  clients.add(client);
  socket.on("pong", () => {
    client.alive = true;
  });

  if (session.clientType === "desktop") {
    try {
      client.deviceId = stringValue(
        url.searchParams.get("deviceId"),
        "设备 ID",
      );
      const name = stringValue(url.searchParams.get("name"), "设备名称", 128);
      const platform = stringValue(
        url.searchParams.get("platform") || "unknown",
        "设备平台",
        64,
      );
      const version = stringValue(
        url.searchParams.get("version") || "unknown",
        "客户端版本",
        64,
      );
      const key = deviceKey(session.userId, client.deviceId);
      const previous = desktops.get(key);
      if (previous && previous !== client)
        previous.socket.close(4001, "该设备已建立新连接");
      desktops.set(key, client);
      database.upsertDevice({
        userId: session.userId,
        id: client.deviceId,
        name,
        platform,
        version,
        online: true,
        now: Date.now(),
      });
      socketSend(socket, { type: "session.ready", role: "desktop" });
      publishDevices(session.userId);
    } catch (error) {
      socket.close(
        1008,
        error instanceof Error ? error.message : "设备信息无效",
      );
    }
  } else {
    socketSend(socket, {
      type: "session.ready",
      role: "mobile",
      devices: onlineDevices(session.userId),
    });
    for (const stream of liveStreams.list(session.userId))
      socketSend(socket, stream);
  }

  socket.on("message", (raw) => {
    let mobileCommandId: string | undefined;
    try {
      const message = JSON.parse(raw.toString()) as unknown;
      if (!isRecord(message)) throw new Error("消息格式无效");
      const type = stringValue(message.type, "消息类型", 64);

      if (session.clientType === "desktop") {
        if (!client.deviceId) throw new Error("设备尚未就绪");
        if (type === "tasks.replace") {
          const tasks = parseTaskSnapshots(message.tasks);
          liveStreams.reconcile(session.userId, client.deviceId, tasks);
          database.replaceTasks(session.userId, client.deviceId, tasks);
          broadcastMobile(session.userId, {
            type: "tasks.changed",
            deviceId: client.deviceId,
            tasks,
            streams: liveStreams.list(session.userId, client.deviceId),
          });
          return;
        }
        if (type === "task.event") {
          const taskEvent = parseRemoteTaskEvent(message);
          const encoded = JSON.stringify(taskEvent);
          if (Buffer.byteLength(encoded, "utf8") > 512 * 1024)
            throw new Error("实时事件过大");
          broadcastMobile(
            session.userId,
            liveStreams.update(session.userId, client.deviceId, taskEvent),
          );
          return;
        }
        if (type === "command.result") {
          const id = stringValue(message.id, "命令 ID");
          const ok = message.ok === true;
          database.finishCommand(
            session.userId,
            id,
            ok ? "completed" : "failed",
            {
              ok,
              error:
                typeof message.error === "string" ? message.error : undefined,
            },
            Date.now(),
          );
          broadcastMobile(session.userId, {
            type: "command.result",
            id,
            ok,
            error:
              typeof message.error === "string" ? message.error : undefined,
          });
          return;
        }
        throw new Error("桌面端消息类型无效");
      }

      if (type === "command") {
        const id =
          typeof message.id === "string" && message.id.trim()
            ? stringValue(message.id, "命令 ID")
            : randomUUID();
        mobileCommandId = id;
        const deviceId = stringValue(message.deviceId, "设备 ID");
        const command = parseRemoteCommand(message.command);
        routeCommand(session, deviceId, command, id);
        socketSend(socket, { type: "command.accepted", id });
        return;
      }
      throw new Error("手机端消息类型无效");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "消息处理失败";
      socketSend(
        socket,
        session.clientType === "mobile" && mobileCommandId
          ? {
              type: "command.result",
              id: mobileCommandId,
              ok: false,
              error: errorMessage,
            }
          : { type: "error", message: errorMessage },
      );
    }
  });

  socket.on("close", () => {
    clients.delete(client);
    if (client.deviceId) {
      const key = deviceKey(session.userId, client.deviceId);
      if (desktops.get(key) === client) {
        desktops.delete(key);
        database.setDeviceOnline(
          session.userId,
          client.deviceId,
          false,
          Date.now(),
        );
        publishDevices(session.userId);
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
  database.cleanExpiredSessions(Date.now());
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () =>
  console.log(`KCode Remote listening on http://${HOST}:${PORT}`),
);

function shutdown() {
  clearInterval(heartbeat);
  for (const client of clients) client.socket.close(1001, "服务正在重启");
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
