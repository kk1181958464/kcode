import {
  isIP,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { MongoClient, type Document, type MongoClientOptions } from "mongodb";
import { openSshForward } from "./ssh";

const MAX_RESULT_DOCUMENTS = 1_000;
const MAX_RESULT_CHARS = 200_000;
export const DEFAULT_MONGO_OPERATION_TIMEOUT_MS = 60_000;

export type MongoConnectInput = {
  uri?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  authSource?: string;
  tls?: boolean;
  tlsCA?: string;
  tlsCertificateKeyFile?: string;
};

export type MongoOperationInput = {
  operation: string;
  collection: string;
  filter?: Document;
  document?: Document;
  documents?: Document[];
  update?: Document | Document[];
  pipeline?: Document[];
  field?: string;
  options?: Document;
};

type MongoTunnel = {
  server: Server;
  sockets: Set<Socket>;
  controller: AbortController;
  close: () => Promise<void>;
};

type MongoSession = {
  client: MongoClient;
  requestId: string;
  host: string;
  port: number;
  database: string;
  viaSsh: boolean;
  tunnel?: MongoTunnel;
};

const sessions = new Map<string, MongoSession>();

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shouldUseMongoTls(host: string, viaSsh: boolean) {
  if (viaSsh) return false;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) return false;
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return !(
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(normalized) === 6)
    return !(
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  return true;
}

function parseMongoUri(uri: string) {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?]+)(.*)$/i.exec(uri.trim());
  if (!match) throw new Error("MongoDB URI 格式无效。");
  const authority = match[2];
  const at = authority.lastIndexOf("@");
  const hosts = authority.slice(at + 1).split(",");
  const first = hosts[0];
  let host = first;
  let port = match[1].toLowerCase() === "mongodb+srv" ? 27017 : 27017;
  if (first.startsWith("[")) {
    const ipv6 = /^\[([^\]]+)](?::(\d+))?$/.exec(first);
    if (!ipv6) throw new Error("MongoDB URI 中的服务器地址无效。");
    host = ipv6[1];
    if (ipv6[2]) port = Number(ipv6[2]);
  } else {
    const hostPort = /^(.*?)(?::(\d+))?$/.exec(first)!;
    host = hostPort[1];
    if (hostPort[2]) port = Number(hostPort[2]);
  }
  return {
    scheme: match[1].toLowerCase(),
    authority,
    suffix: match[3],
    hosts,
    host,
    port,
  };
}

function uriTlsSetting(uri: string) {
  const match = /[?&](?:tls|ssl)=([^&]+)/i.exec(uri);
  if (!match) return undefined;
  return decodeURIComponent(match[1]).toLowerCase() === "true";
}

async function openMongoTunnel(
  sessionId: string,
  requestId: string,
  destinationHost: string,
  destinationPort: number,
  signal: AbortSignal,
) {
  // MongoClient has no public socket factory. A loopback-only proxy supplies
  // one SSH channel per pool/monitor socket without relying on driver internals.
  const sockets = new Set<Socket>();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("MongoDB SSH 通道已关闭。"));
  signal.addEventListener("abort", abort, { once: true });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void openSshForward(
      sessionId,
      requestId,
      destinationHost,
      destinationPort,
      controller.signal,
    ).then(
      (channel) => {
        socket.pipe(channel).pipe(socket);
        channel.once("error", () => socket.destroy());
        channel.once("close", () => socket.destroy());
      },
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  const close = async () => {
    signal.removeEventListener("abort", abort);
    controller.abort(new Error("MongoDB SSH 通道已关闭。"));
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, sockets, controller, close } satisfies MongoTunnel;
}

function friendlyMongoError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  if (/MongoDB .*已取消|MongoDB .*超时/.test(message)) return message;
  if (
    /authentication failed|auth failed|bad auth/i.test(message) ||
    code === "18"
  )
    return "MongoDB 身份验证失败，请检查用户名、密码和 authSource。";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message))
    return "MongoDB 连接被拒绝，请检查地址、端口和服务状态。";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "MongoDB 服务器地址无法解析。";
  if (/timeout|timed out|server selection/i.test(message))
    return "MongoDB 连接或操作超时，请检查网络、防火墙或 SSH 通道目标地址。";
  if (/tls|ssl|certificate/i.test(message))
    return `MongoDB TLS 连接失败：${message}`;
  if (/not authorized|unauthorized/i.test(message))
    return "MongoDB 权限不足，当前账号无权执行该操作。";
  return `MongoDB 操作失败：${message}`;
}

export async function connectMongo(
  sessionId: string,
  requestId: string,
  input: MongoConnectInput,
  viaSsh: boolean,
  signal: AbortSignal,
) {
  const suppliedUri = input.uri?.trim();
  if (suppliedUri && input.host?.trim())
    throw new Error("MongoDB 连接请只提供 uri 或 host，不能同时提供。");
  if (!suppliedUri && !input.host?.trim())
    throw new Error("缺少 MongoDB URI 或服务器地址。");

  const parsed = suppliedUri ? parseMongoUri(suppliedUri) : undefined;
  const host = parsed?.host ?? input.host!.trim();
  const port = parsed?.port ?? (Number(input.port) || 27017);
  if (!host) throw new Error("缺少 MongoDB 服务器地址。");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("MongoDB 端口必须是 1 到 65535 之间的整数。");
  if (
    viaSsh &&
    (parsed?.scheme === "mongodb+srv" || (parsed?.hosts.length ?? 1) !== 1)
  )
    throw new Error(
      "MongoDB SSH 通道仅支持单主机 mongodb:// URI；请改用 host 和 port。",
    );

  const uriTls = suppliedUri ? uriTlsSetting(suppliedUri) : undefined;
  const useTls = input.tls ?? uriTls ?? shouldUseMongoTls(host, viaSsh);
  let tunnel: MongoTunnel | undefined;
  let client: MongoClient | undefined;
  try {
    if (viaSsh)
      tunnel = await openMongoTunnel(sessionId, requestId, host, port, signal);
    const localPort = tunnel
      ? (tunnel.server.address() as AddressInfo).port
      : port;
    let uri: string;
    if (suppliedUri && tunnel && parsed) {
      const credentials = parsed.authority.includes("@")
        ? `${parsed.authority.slice(0, parsed.authority.lastIndexOf("@") + 1)}`
        : "";
      uri = `mongodb://${credentials}127.0.0.1:${localPort}${parsed.suffix}`;
    } else if (suppliedUri) uri = suppliedUri;
    else {
      const credentials = input.username
        ? `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password ?? "")}@`
        : "";
      const database = input.database?.trim()
        ? `/${encodeURIComponent(input.database.trim())}`
        : "";
      uri = `mongodb://${credentials}${tunnel ? "127.0.0.1" : host}:${localPort}${database}`;
    }
    const options: MongoClientOptions = {
      connectTimeoutMS: 30_000,
      serverSelectionTimeoutMS: 30_000,
      tls: useTls,
      ca: input.tlsCA,
      tlsCertificateKeyFile: input.tlsCertificateKeyFile,
      authSource: input.authSource?.trim() || undefined,
      directConnection: viaSsh ? true : undefined,
    };
    client = new MongoClient(uri, options);
    const abort = () => void client?.close(true);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      if (signal.aborted) throw new Error("MongoDB 连接已取消。");
      await client
        .db(input.database?.trim() || undefined)
        .command({ ping: 1 }, { signal });
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const database =
      input.database?.trim() || parseDatabaseName(suppliedUri) || "test";
    const previous = sessions.get(sessionId);
    sessions.set(sessionId, {
      client,
      requestId,
      host,
      port,
      database,
      viaSsh,
      tunnel,
    });
    if (previous) void closeSession(previous);
    return { connected: true, host, port, database, viaSsh, tls: useTls };
  } catch (error) {
    await client?.close(true).catch(() => undefined);
    await tunnel?.close().catch(() => undefined);
    throw new Error(friendlyMongoError(error));
  }
}

function parseDatabaseName(uri?: string) {
  if (!uri) return undefined;
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/i.exec(uri);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function validateOperation(input: MongoOperationInput) {
  const operation = input.operation?.trim();
  if (!input.collection?.trim()) throw new Error("缺少 MongoDB collection。");
  const supported = new Set([
    "find",
    "aggregate",
    "insertOne",
    "insertMany",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
    "countDocuments",
    "distinct",
  ]);
  if (!supported.has(operation))
    throw new Error(`不支持的 MongoDB 操作：${operation || "未提供"}。`);
  if (input.filter !== undefined && !isDocument(input.filter))
    throw new Error("MongoDB filter 必须是对象。");
  if (
    operation === "aggregate" &&
    (!Array.isArray(input.pipeline) ||
      input.pipeline.some((v) => !isDocument(v)))
  )
    throw new Error("MongoDB aggregate 需要由对象组成的 pipeline 数组。");
  if (operation === "insertOne" && !isDocument(input.document))
    throw new Error("MongoDB insertOne 需要 document 对象。");
  if (
    operation === "insertMany" &&
    (!Array.isArray(input.documents) ||
      input.documents.length === 0 ||
      input.documents.some((v) => !isDocument(v)))
  )
    throw new Error("MongoDB insertMany 需要非空 documents 对象数组。");
  const update = input.update as unknown;
  const validUpdate =
    isDocument(update) ||
    (Array.isArray(update) && update.length > 0 && update.every(isDocument));
  if ((operation === "updateOne" || operation === "updateMany") && !validUpdate)
    throw new Error(`MongoDB ${operation} 需要 update 对象或非空 pipeline。`);
  if (operation === "distinct" && !input.field?.trim())
    throw new Error("MongoDB distinct 需要 field。");
  if (input.options !== undefined && !isDocument(input.options))
    throw new Error("MongoDB options 必须是对象。");
  return operation;
}

function limitedJson(documents: unknown[], result?: unknown) {
  const stored: unknown[] = [];
  let chars = 0;
  let truncated = documents.length > MAX_RESULT_DOCUMENTS;
  for (const document of documents.slice(0, MAX_RESULT_DOCUMENTS)) {
    const serialized = JSON.stringify(document);
    if (chars + serialized.length > MAX_RESULT_CHARS) {
      truncated = true;
      break;
    }
    stored.push(document);
    chars += serialized.length;
  }
  return JSON.stringify({
    documents: stored,
    documentCount: truncated ? `至少 ${documents.length}` : documents.length,
    truncated,
    result,
  });
}

export async function executeMongo(
  sessionId: string,
  requestId: string,
  input: MongoOperationInput,
  signal: AbortSignal,
  timeoutMs = DEFAULT_MONGO_OPERATION_TIMEOUT_MS,
) {
  const operation = validateOperation(input);
  const session = sessions.get(sessionId);
  if (!session)
    throw new Error("当前任务尚未连接 MongoDB，请先调用 MongoDB 连接工具。");
  session.requestId = requestId;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("MongoDB 操作已取消。"));
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`MongoDB 操作超时（${Math.round(timeoutMs / 1_000)} 秒）。`),
      ),
    timeoutMs,
  );
  const options = {
    ...(input.options ?? {}),
    maxTimeMS: timeoutMs,
    signal: controller.signal,
  };
  try {
    const collection: any = session.client
      .db(session.database)
      .collection(input.collection.trim());
    let result: unknown;
    let documents: unknown[] = [];
    switch (operation) {
      case "find":
        documents = await collection
          .find(input.filter ?? {}, options)
          .limit(MAX_RESULT_DOCUMENTS + 1)
          .toArray();
        break;
      case "aggregate":
        documents = await collection
          .aggregate(input.pipeline!, options)
          .limit(MAX_RESULT_DOCUMENTS + 1)
          .toArray();
        break;
      case "insertOne":
        result = await collection.insertOne(input.document!, options);
        break;
      case "insertMany":
        result = await collection.insertMany(input.documents!, options);
        break;
      case "updateOne":
        result = await collection.updateOne(
          input.filter ?? {},
          input.update!,
          options,
        );
        break;
      case "updateMany":
        result = await collection.updateMany(
          input.filter ?? {},
          input.update!,
          options,
        );
        break;
      case "deleteOne":
        result = await collection.deleteOne(input.filter ?? {}, options);
        break;
      case "deleteMany":
        result = await collection.deleteMany(input.filter ?? {}, options);
        break;
      case "countDocuments":
        result = {
          count: await collection.countDocuments(input.filter ?? {}, options),
        };
        break;
      case "distinct":
        documents = await collection.distinct(
          input.field!.trim(),
          input.filter ?? {},
          options,
        );
        break;
    }
    return limitedJson(documents, result);
  } catch (error) {
    if (controller.signal.aborted) {
      sessions.delete(sessionId);
      await closeSession(session);
      const timedOut =
        controller.signal.reason instanceof Error &&
        /超时/.test(controller.signal.reason.message);
      throw new Error(
        timedOut
          ? `MongoDB 操作超时（${Math.round(timeoutMs / 1_000)} 秒），连接已关闭。`
          : "MongoDB 操作已取消，连接已关闭。",
      );
    }
    throw new Error(friendlyMongoError(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function closeSession(session: MongoSession) {
  await session.client.close(true).catch(() => undefined);
  await session.tunnel?.close().catch(() => undefined);
}

export async function disconnectMongo(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await closeSession(session);
  return true;
}

export function adoptMongoSession(fromSessionId: string, toSessionId: string) {
  const incoming = sessions.get(fromSessionId);
  if (!incoming) throw new Error("待切换的 MongoDB 连接不存在。");
  const previous = sessions.get(toSessionId);
  sessions.delete(fromSessionId);
  sessions.set(toSessionId, incoming);
  if (previous) void closeSession(previous);
}

export function cleanupMongoSessions(ids: string[]) {
  const targets = new Set(ids);
  for (const [sessionId, session] of sessions)
    if (targets.has(sessionId) || targets.has(session.requestId))
      void disconnectMongo(sessionId);
}

export function closeAllMongoSessions() {
  for (const sessionId of [...sessions.keys()]) void disconnectMongo(sessionId);
}
