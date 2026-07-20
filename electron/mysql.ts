import { isIP } from "node:net";
import {
  createConnection,
  type Connection,
  type ConnectionOptions,
  type FieldPacket,
} from "mysql2";
import { openSshForward } from "./ssh";

const MAX_RESULT_ROWS = 1_000;
const MAX_RESULT_CHARS = 200_000;
export const DEFAULT_MYSQL_QUERY_TIMEOUT_MS = 60_000;

type MysqlSession = {
  connection: Connection;
  requestId: string;
  host: string;
  port: number;
  username: string;
  database?: string;
  viaSsh: boolean;
};

export type MysqlConnectInput = {
  host: string;
  port?: number;
  username: string;
  password: string;
  database?: string;
  ssl?: boolean;
  sslCa?: string;
  sslCert?: string;
  sslKey?: string;
  sslPassphrase?: string;
  sslRejectUnauthorized?: boolean;
};

const sessions = new Map<string, MysqlSession>();

function friendlyMysqlError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  if (code === "ER_ACCESS_DENIED_ERROR" || /access denied/i.test(message))
    return "MySQL 身份验证失败，请检查数据库账号、密码及允许登录的主机。";
  if (code === "ER_BAD_DB_ERROR" || /unknown database/i.test(message))
    return "指定的 MySQL 数据库不存在。";
  if (code === "ECONNREFUSED")
    return "MySQL 连接被拒绝，请检查地址、端口和服务状态。";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "MySQL 服务器地址无法解析。";
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(message))
    return "MySQL 连接超时，请检查网络、防火墙或 SSH 通道目标地址。";
  if (/ssl|tls|secure connection/i.test(message))
    return `MySQL TLS 连接失败：${message}`;
  if (code === "PROTOCOL_CONNECTION_LOST") return "MySQL 连接已断开。";
  return `MySQL 操作失败：${message}`;
}

function getSession(sessionId: string, requestId: string) {
  const session = sessions.get(sessionId);
  if (!session)
    throw new Error("当前任务尚未连接 MySQL，请先调用 MySQL 连接工具。");
  session.requestId = requestId;
  return session;
}

export function shouldUseMysqlTls(host: string, viaSsh: boolean) {
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
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  return true;
}

export async function connectMysql(
  sessionId: string,
  requestId: string,
  input: MysqlConnectInput,
  viaSsh: boolean,
  signal: AbortSignal,
) {
  const host = input.host.trim();
  const username = input.username.trim();
  const port = Number(input.port) || 3306;
  if (!host) throw new Error("缺少 MySQL 服务器地址。");
  if (!username) throw new Error("缺少 MySQL 用户名。");
  if (!input.password) throw new Error("缺少 MySQL 密码。");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("MySQL 端口必须是 1 到 65535 之间的整数。");

  const useTls = input.ssl ?? shouldUseMysqlTls(host, viaSsh);
  const stream = viaSsh
    ? await openSshForward(sessionId, requestId, host, port, signal)
    : undefined;
  const options: ConnectionOptions = {
    host: viaSsh ? "127.0.0.1" : host,
    port,
    user: username,
    password: input.password,
    database: input.database?.trim() || undefined,
    connectTimeout: 30_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    stream,
    ssl: useTls
      ? {
          ca: input.sslCa,
          cert: input.sslCert,
          key: input.sslKey,
          passphrase: input.sslPassphrase,
          rejectUnauthorized: input.sslRejectUnauthorized ?? true,
        }
      : undefined,
  };

  let connection: Connection;
  try {
    connection = createConnection(options);
  } catch (error) {
    stream?.destroy();
    throw new Error(friendlyMysqlError(error));
  }
  const handleConnectionError = () => {
    for (const [key, value] of sessions)
      if (value.connection === connection) sessions.delete(key);
  };
  connection.on("error", handleConnectionError);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      connection.removeListener("connect", ready);
      connection.removeListener("error", failed);
      if (error) {
        connection.destroy();
        stream?.destroy();
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new Error("MySQL 连接已取消。"));
    const ready = () => finish();
    const failed = (error: Error) =>
      finish(new Error(friendlyMysqlError(error)));
    signal.addEventListener("abort", abort, { once: true });
    connection.once("connect", ready);
    connection.once("error", failed);
    if (signal.aborted) abort();
  });
  if (signal.aborted) {
    connection.destroy();
    throw new Error("MySQL 连接已取消。");
  }

  const previous = sessions.get(sessionId);
  const session: MysqlSession = {
    connection,
    requestId,
    host,
    port,
    username,
    database: input.database?.trim() || undefined,
    viaSsh,
  };
  sessions.set(sessionId, session);
  previous?.connection.end(() => undefined);
  return {
    connected: true,
    host,
    port,
    username,
    database: session.database,
    viaSsh,
    tls: useTls,
  };
}

export async function queryMysql(
  sessionId: string,
  requestId: string,
  sql: string,
  values: unknown[],
  signal: AbortSignal,
  timeoutMs = DEFAULT_MYSQL_QUERY_TIMEOUT_MS,
) {
  if (!sql.trim()) throw new Error("缺少 SQL 语句。");
  const session = getSession(sessionId, requestId);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let fields: string[] = [];
    let hasFields = false;
    let resultCount = 0;
    let storedChars = 0;
    let truncated = false;
    const stored: string[] = [];
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) return reject(error);
      const key = hasFields ? "rows" : "results";
      const output = `{"${key}":[${stored.join(",")}],"rowCount":${resultCount},"truncated":${truncated},"fields":${JSON.stringify(fields)}}`;
      resolve(output);
    };
    const abort = () => {
      sessions.delete(sessionId);
      session.connection.destroy();
      finish(new Error("MySQL 查询已取消，连接已关闭。"));
    };
    const timer = setTimeout(() => {
      sessions.delete(sessionId);
      session.connection.destroy();
      finish(
        new Error(
          `MySQL 查询超时（${Math.round(timeoutMs / 1_000)} 秒），连接已关闭。`,
        ),
      );
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    let query;
    try {
      query = session.connection.query(sql, values as any);
    } catch (error) {
      finish(new Error(friendlyMysqlError(error)));
      return;
    }
    query.on("fields", (packets: FieldPacket[] | FieldPacket) => {
      hasFields = true;
      const list = Array.isArray(packets) ? packets : [packets];
      fields = list.map((field) => field.name);
    });
    query.on("result", (result: unknown) => {
      resultCount += 1;
      if (stored.length >= MAX_RESULT_ROWS || storedChars >= MAX_RESULT_CHARS) {
        truncated = true;
        return;
      }
      const serialized = JSON.stringify(result);
      if (storedChars + serialized.length > MAX_RESULT_CHARS) {
        truncated = true;
        return;
      }
      stored.push(serialized);
      storedChars += serialized.length;
    });
    query.once("error", (error: Error) =>
      finish(new Error(friendlyMysqlError(error))),
    );
    query.once("end", () => finish());
    if (signal.aborted) abort();
  });
}

export async function disconnectMysql(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      session.connection.destroy();
      resolve();
    }, 2_000);
    session.connection.end(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return true;
}

export function adoptMysqlSession(fromSessionId: string, toSessionId: string) {
  const incoming = sessions.get(fromSessionId);
  if (!incoming) throw new Error("待切换的 MySQL 连接不存在。");
  const previous = sessions.get(toSessionId);
  sessions.delete(fromSessionId);
  sessions.set(toSessionId, incoming);
  previous?.connection.end(() => undefined);
}

export function cleanupMysqlSessions(ids: string[]) {
  const targets = new Set(ids);
  for (const [sessionId, session] of sessions)
    if (targets.has(sessionId) || targets.has(session.requestId))
      void disconnectMysql(sessionId);
}

export function closeAllMysqlSessions() {
  for (const sessionId of [...sessions.keys()]) void disconnectMysql(sessionId);
}
