import { isIP } from "node:net";
import type { Socket } from "node:net";
import mssql, { type config as SqlServerConfig } from "mssql";
import { openSshForward } from "./ssh";
import {
  assertSingleSqlServerStatement,
  redactSqlForActivity,
} from "./sql-policy";

const MAX_RESULT_ROWS = 1_000;
const MAX_RESULT_CHARS = 200_000;
export const DEFAULT_SQL_SERVER_QUERY_TIMEOUT_MS = 60_000;

type SqlServerSession = {
  pool: mssql.ConnectionPool;
  requestId: string;
  host: string;
  port: number;
  username: string;
  database?: string;
  viaSsh: boolean;
};

export type SqlServerConnectInput = {
  host: string;
  port?: number;
  username: string;
  password: string;
  database?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
};

const sessions = new Map<string, SqlServerSession>();

function normalizedHost(host: string) {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function isPrivateSqlServerHost(host: string) {
  const normalized = normalizedHost(host);
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(normalized) === 6)
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  return false;
}

export function shouldEncryptSqlServer(host: string, viaSsh: boolean) {
  return !viaSsh && !isPrivateSqlServerHost(host);
}

export function shouldTrustSqlServerCertificate(host: string) {
  return isPrivateSqlServerHost(host);
}

export function redactSqlServerInput(input: Record<string, unknown>) {
  const redacted = { ...input };
  for (const key of [
    "password",
    "sshPassword",
    "sshPrivateKey",
    "sshPassphrase",
  ])
    if (key in redacted) redacted[key] = "[已隐藏]";
  if ("values" in redacted && Array.isArray(redacted.values))
    redacted.values = `[已隐藏 ${redacted.values.length} 个参数]`;
  if (typeof redacted.sql === "string")
    redacted.sql = redactSqlForActivity(redacted.sql);
  return redacted;
}

function friendlySqlServerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  if (code === "ELOGIN" || /login failed|authentication/i.test(message))
    return "SQL Server 身份验证失败，请检查数据库账号和密码。";
  if (/cannot open database|unknown database/i.test(message))
    return "指定的 SQL Server 数据库不存在或当前账号无权访问。";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message))
    return "SQL Server 连接被拒绝，请检查地址、端口和服务状态。";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message))
    return "SQL Server 地址无法解析。";
  if (code === "ETIMEOUT" || /timeout|timed out/i.test(message))
    return "SQL Server 连接或操作超时，请检查网络、防火墙或 SSH 通道目标地址。";
  if (/certificate|SSL|TLS|encrypt/i.test(message))
    return "SQL Server TLS 连接失败，请检查加密和服务器证书设置。";
  if (
    code === "ECONNCLOSED" ||
    code === "ENOTOPEN" ||
    /socket hang up/i.test(message)
  )
    return "SQL Server 连接已断开。";
  if (code === "EREQUEST") return "SQL Server 拒绝执行该 SQL 语句。";
  return "SQL Server 操作失败。";
}

function getSession(sessionId: string, requestId: string) {
  const session = sessions.get(sessionId);
  if (!session)
    throw new Error(
      "当前任务尚未连接 SQL Server，请先调用 SQL Server 连接工具。",
    );
  session.requestId = requestId;
  return session;
}

function closePool(pool: mssql.ConnectionPool) {
  return pool.close().catch(() => undefined);
}

export async function connectSqlServer(
  sessionId: string,
  requestId: string,
  input: SqlServerConnectInput,
  viaSsh: boolean,
  signal: AbortSignal,
) {
  const host = input.host.trim();
  const username = input.username.trim();
  const port = Number(input.port) || 1433;
  if (!host) throw new Error("缺少 SQL Server 地址。");
  if (!username) throw new Error("缺少 SQL Server 用户名。");
  if (!input.password) throw new Error("缺少 SQL Server 密码。");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SQL Server 端口必须是 1 到 65535 之间的整数。");

  const encrypt = input.encrypt ?? shouldEncryptSqlServer(host, viaSsh);
  const trustServerCertificate =
    input.trustServerCertificate ?? shouldTrustSqlServerCertificate(host);
  const options: SqlServerConfig["options"] & {
    connector?: () => Promise<Socket>;
  } = {
    encrypt,
    trustServerCertificate,
    enableArithAbort: true,
    connectTimeout: 30_000,
  };
  if (viaSsh)
    options.connector = async () =>
      (await openSshForward(
        sessionId,
        requestId,
        host,
        port,
        signal,
      )) as unknown as Socket;

  const config: SqlServerConfig = {
    server: viaSsh ? "127.0.0.1" : host,
    port,
    user: username,
    password: input.password,
    database: input.database?.trim() || undefined,
    connectionTimeout: 30_000,
    requestTimeout: DEFAULT_SQL_SERVER_QUERY_TIMEOUT_MS,
    options,
    pool: { min: 0, max: 1, idleTimeoutMillis: 30_000 },
  };
  const pool = new mssql.ConnectionPool(config);
  pool.on("error", () => {
    for (const [key, value] of sessions)
      if (value.pool === pool) sessions.delete(key);
  });

  let aborted = false;
  const abort = () => {
    aborted = true;
    void closePool(pool);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    await pool.connect();
    if (aborted || signal.aborted) {
      await closePool(pool);
      throw new Error("SQL Server 连接已取消。");
    }
  } catch (error) {
    await closePool(pool);
    if (aborted || signal.aborted) throw new Error("SQL Server 连接已取消。");
    throw new Error(friendlySqlServerError(error));
  } finally {
    signal.removeEventListener("abort", abort);
  }

  const previous = sessions.get(sessionId);
  const session: SqlServerSession = {
    pool,
    requestId,
    host,
    port,
    username,
    database: input.database?.trim() || undefined,
    viaSsh,
  };
  sessions.set(sessionId, session);
  if (previous) void closePool(previous.pool);
  return {
    connected: true,
    host,
    port,
    username,
    database: session.database,
    viaSsh,
    encrypt,
    trustServerCertificate,
  };
}

export async function querySqlServer(
  sessionId: string,
  requestId: string,
  sql: string,
  values: unknown[],
  signal: AbortSignal,
  timeoutMs = DEFAULT_SQL_SERVER_QUERY_TIMEOUT_MS,
) {
  if (!sql.trim()) throw new Error("缺少 SQL 语句。");
  assertSingleSqlServerStatement(sql);
  const session = getSession(sessionId, requestId);
  const request = session.pool.request();
  values.forEach((value, index) =>
    request.input(`p${index + 1}`, value ?? null),
  );
  request.stream = true;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let fields: string[] = [];
    let rowCount = 0;
    let affectedCount = 0;
    let storedChars = 0;
    let truncated = false;
    const stored: string[] = [];
    const closeSession = () => {
      sessions.delete(sessionId);
      request.cancel();
      void closePool(session.pool);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) return reject(error);
      resolve(
        JSON.stringify({
          rows: stored.map((item) => JSON.parse(item)),
          rowCount: rowCount || affectedCount,
          truncated,
          fields,
        }),
      );
    };
    const abort = () => {
      closeSession();
      finish(new Error("SQL Server 查询已取消，连接已关闭。"));
    };
    const boundedTimeout = Math.max(1, timeoutMs);
    const timer = setTimeout(() => {
      closeSession();
      finish(
        new Error(
          `SQL Server 查询超时（${Math.round(boundedTimeout / 1_000)} 秒），连接已关闭。`,
        ),
      );
    }, boundedTimeout);
    signal.addEventListener("abort", abort, { once: true });
    request.on("recordset", (columns: Record<string, unknown>) => {
      if (fields.length === 0) fields = Object.keys(columns);
    });
    request.on("row", (row: unknown) => {
      rowCount += 1;
      if (stored.length >= MAX_RESULT_ROWS || storedChars >= MAX_RESULT_CHARS) {
        truncated = true;
        return;
      }
      const serialized = JSON.stringify(row);
      if (
        serialized === undefined ||
        storedChars + serialized.length > MAX_RESULT_CHARS
      ) {
        truncated = true;
        return;
      }
      stored.push(serialized);
      storedChars += serialized.length;
    });
    request.on("rowsaffected", (count: number) => {
      affectedCount += count;
    });
    request
      .query(sql)
      .then(() => finish())
      .catch((error) => finish(new Error(friendlySqlServerError(error))));
    if (signal.aborted) abort();
  });
}

export async function disconnectSqlServer(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  await closePool(session.pool);
  return true;
}

export function adoptSqlServerSession(
  fromSessionId: string,
  toSessionId: string,
) {
  const incoming = sessions.get(fromSessionId);
  if (!incoming) throw new Error("待切换的 SQL Server 连接不存在。");
  const previous = sessions.get(toSessionId);
  sessions.delete(fromSessionId);
  sessions.set(toSessionId, incoming);
  if (previous) void closePool(previous.pool);
}

export function cleanupSqlServerSessions(ids: string[]) {
  const targets = new Set(ids);
  for (const [sessionId, session] of sessions)
    if (targets.has(sessionId) || targets.has(session.requestId))
      void disconnectSqlServer(sessionId);
}

export function closeAllSqlServerSessions() {
  for (const sessionId of [...sessions.keys()])
    void disconnectSqlServer(sessionId);
}
