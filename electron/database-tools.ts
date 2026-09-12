import { createRequire } from "node:module";
import type { ToolResult } from "./agent-types";
import {
  connectWithPreparedSsh,
  type PreparedDatabaseSsh,
} from "./database-connection";
import {
  disconnectDatabase,
  executeSqlQuery,
  mongoOperationResult,
} from "./database-operations";
import { publicCredentialReference } from "./credential-tools";
import { mutationChangedFromOutput } from "./mutation-evidence";
import type {
  CredentialDescriptor,
  SaveCredentialInput,
} from "./credential-vault";
import type { MysqlConnectInput } from "./mysql";
import type { SqlServerConnectInput } from "./sqlserver";
import type { MongoConnectInput, MongoOperationInput } from "./mongodb";
import type { SqlRisk } from "./sql-policy";

const requireProduction = createRequire(__filename);

export type DatabaseKind = "mysql" | "sqlserver" | "mongodb";

type DatabaseConnectInput =
  | MysqlConnectInput
  | SqlServerConnectInput
  | MongoConnectInput;

export type DatabaseToolDeps = {
  resolveCredentialProfile: (
    kind: DatabaseKind,
    selector: string,
  ) => Promise<{
    descriptor: CredentialDescriptor;
    payload: Record<string, unknown>;
  }>;
  saveCredentialProfile: (
    input: SaveCredentialInput,
  ) => Promise<CredentialDescriptor>;
  savedSshCredential: (
    selector: string,
  ) => Promise<{ id: string; name: string }>;
  connectSavedSshRemote: (
    taskId: string,
    profileId: string,
    rootPath?: string,
  ) => Promise<unknown>;
  sshRemoteState: (taskId: string) => Promise<{
    connected: boolean;
    profile?: { name: string; remembered?: boolean };
  }>;
  connectSsh: (
    sessionId: string,
    requestId: string,
    input: {
      host: string;
      port: number;
      username: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      rememberForRemoteWorkspace: boolean;
    },
    signal: AbortSignal,
  ) => Promise<unknown>;
  adoptActiveSshRemote: (
    taskId: string,
    requestedRootPath?: string,
    preferredName?: string,
  ) => Promise<{ profile?: { name: string; remembered?: boolean } }>;
  adoptSshSession: (fromSessionId: string, toSessionId: string) => void;
  disconnectSsh: (sessionId: string) => boolean;
  connectMysql: (
    sessionId: string,
    requestId: string,
    input: MysqlConnectInput,
    viaSsh: boolean,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  queryMysql: (
    sessionId: string,
    requestId: string,
    sql: string,
    values: unknown[],
    signal: AbortSignal,
  ) => Promise<string>;
  disconnectMysql: (sessionId: string) => Promise<boolean>;
  adoptMysqlSession: (fromSessionId: string, toSessionId: string) => void;
  connectSqlServer: (
    sessionId: string,
    requestId: string,
    input: SqlServerConnectInput,
    viaSsh: boolean,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  querySqlServer: (
    sessionId: string,
    requestId: string,
    sql: string,
    values: unknown[],
    signal: AbortSignal,
  ) => Promise<string>;
  disconnectSqlServer: (sessionId: string) => Promise<boolean>;
  adoptSqlServerSession: (fromSessionId: string, toSessionId: string) => void;
  connectMongo: (
    sessionId: string,
    requestId: string,
    input: MongoConnectInput,
    viaSsh: boolean,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  executeMongo: (
    sessionId: string,
    requestId: string,
    input: MongoOperationInput,
    signal: AbortSignal,
  ) => Promise<string>;
  disconnectMongo: (sessionId: string) => Promise<boolean>;
  adoptMongoSession: (fromSessionId: string, toSessionId: string) => void;
  classifyMysqlSql: (sql: string) => SqlRisk;
  classifySqlServerSql: (sql: string) => SqlRisk;
};

export type DatabaseToolContext = {
  browserSessionId: string;
  requestId: string;
  activityId: string;
  name: string;
  input: Record<string, unknown>;
  remoteWorkspaceRoot?: string;
  signal: AbortSignal;
};

function productionDatabaseDeps(): DatabaseToolDeps {
  const vault = requireProduction("./credential-vault") as typeof import("./credential-vault");
  const cred = requireProduction("./credential-tools") as typeof import("./credential-tools");
  const ssh = requireProduction("./ssh") as typeof import("./ssh");
  const remote = requireProduction("./ssh-remote") as typeof import("./ssh-remote");
  const mysql = requireProduction("./mysql") as typeof import("./mysql");
  const sqlserver = requireProduction("./sqlserver") as typeof import("./sqlserver");
  const mongodb = requireProduction("./mongodb") as typeof import("./mongodb");
  const policy = requireProduction("./sql-policy") as typeof import("./sql-policy");
  return {
    resolveCredentialProfile: vault.resolveCredentialProfile,
    saveCredentialProfile: vault.saveCredentialProfile,
    savedSshCredential: cred.savedSshCredential,
    connectSavedSshRemote: remote.connectSavedSshRemote,
    sshRemoteState: remote.sshRemoteState,
    connectSsh: ssh.connectSsh,
    adoptActiveSshRemote: remote.adoptActiveSshRemote,
    adoptSshSession: ssh.adoptSshSession,
    disconnectSsh: ssh.disconnectSsh,
    connectMysql: mysql.connectMysql,
    queryMysql: mysql.queryMysql,
    disconnectMysql: mysql.disconnectMysql,
    adoptMysqlSession: mysql.adoptMysqlSession,
    connectSqlServer: sqlserver.connectSqlServer,
    querySqlServer: sqlserver.querySqlServer,
    disconnectSqlServer: sqlserver.disconnectSqlServer,
    adoptSqlServerSession: sqlserver.adoptSqlServerSession,
    connectMongo: mongodb.connectMongo,
    executeMongo: mongodb.executeMongo,
    disconnectMongo: mongodb.disconnectMongo,
    adoptMongoSession: mongodb.adoptMongoSession,
    classifyMysqlSql: policy.classifyMysqlSql,
    classifySqlServerSql: policy.classifySqlServerSql,
  };
}

export function isSchemaMutationSql(sql: string) {
  return /^\s*(?:create|alter|drop|truncate|rename|grant|revoke)\b/i.test(sql);
}

export function mysqlConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): MysqlConnectInput {
  return {
    host: String(input.host || defaultHost),
    port: Number(input.port) || 3306,
    username: String(input.username || ""),
    password: String(input.password || ""),
    database: typeof input.database === "string" ? input.database : undefined,
    ssl: typeof input.ssl === "boolean" ? input.ssl : undefined,
    sslCa: typeof input.sslCa === "string" ? input.sslCa : undefined,
    sslCert: typeof input.sslCert === "string" ? input.sslCert : undefined,
    sslKey: typeof input.sslKey === "string" ? input.sslKey : undefined,
    sslPassphrase:
      typeof input.sslPassphrase === "string" ? input.sslPassphrase : undefined,
    sslRejectUnauthorized:
      typeof input.sslRejectUnauthorized === "boolean"
        ? input.sslRejectUnauthorized
        : undefined,
  };
}

export function sqlServerConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): SqlServerConnectInput {
  return {
    host: String(input.host || defaultHost),
    port: Number(input.port) || 1433,
    username: String(input.username || ""),
    password: String(input.password || ""),
    database: typeof input.database === "string" ? input.database : undefined,
    encrypt: typeof input.encrypt === "boolean" ? input.encrypt : undefined,
    trustServerCertificate:
      typeof input.trustServerCertificate === "boolean"
        ? input.trustServerCertificate
        : undefined,
  };
}

export function mongoConnectInput(
  input: Record<string, unknown>,
  defaultHost = "",
): MongoConnectInput {
  return {
    uri: typeof input.uri === "string" ? input.uri : undefined,
    host: String(input.host || defaultHost),
    port: Number(input.port) || 27017,
    username: typeof input.username === "string" ? input.username : undefined,
    password: typeof input.password === "string" ? input.password : undefined,
    database: String(input.database || ""),
    authSource:
      typeof input.authSource === "string" ? input.authSource : undefined,
    tls: typeof input.tls === "boolean" ? input.tls : undefined,
    tlsCA: typeof input.tlsCA === "string" ? input.tlsCA : undefined,
    tlsCertificateKeyFile:
      typeof input.tlsCertificateKeyFile === "string"
        ? input.tlsCertificateKeyFile
        : undefined,
  };
}

async function databaseCredentialInput(
  kind: DatabaseKind,
  rawInput: Record<string, unknown>,
  deps: DatabaseToolDeps,
) {
  const selector = String(rawInput.credentialName || "").trim();
  if (!selector)
    return {
      source: undefined,
      input: rawInput,
    };
  const source = await deps.resolveCredentialProfile(kind, selector);
  return {
    source: source.descriptor,
    input: source.payload,
  };
}

export async function prepareDatabaseSsh(
  taskId: string,
  requestId: string,
  activityId: string,
  input: Record<string, unknown>,
  linkedCredentialName: string | undefined,
  signal: AbortSignal,
  workspaceRoot: string | undefined,
  deps: DatabaseToolDeps,
): Promise<PreparedDatabaseSsh> {
  const explicitCredentialName = String(input.sshCredentialName || "").trim();
  if (explicitCredentialName && input.sshHost)
    throw new Error("SSH 凭据别名与新的 SSH 连接信息不能同时提供。");
  const requestedCredentialName =
    explicitCredentialName ||
    (input.sshHost ? "" : String(linkedCredentialName || "").trim());
  if (requestedCredentialName) {
    const profile = await deps.savedSshCredential(requestedCredentialName);
    await deps.connectSavedSshRemote(taskId, profile.id, workspaceRoot);
    return {
      sessionId: taskId,
      temporary: false,
      credentialName: profile.name,
    };
  }
  if (!input.sshHost) {
    const state = await deps.sshRemoteState(taskId);
    return {
      sessionId: taskId,
      temporary: false,
      credentialName: state.connected ? state.profile?.name : undefined,
    };
  }
  const sessionId = `${taskId}:pending:${activityId}`;
  await deps.connectSsh(
    sessionId,
    requestId,
    {
      host: String(input.sshHost),
      port: Number(input.sshPort) || 22,
      username: String(input.sshUsername || ""),
      password:
        typeof input.sshPassword === "string" ? input.sshPassword : undefined,
      privateKey:
        typeof input.sshPrivateKey === "string"
          ? input.sshPrivateKey
          : undefined,
      passphrase:
        typeof input.sshPassphrase === "string"
          ? input.sshPassphrase
          : undefined,
      rememberForRemoteWorkspace: input.remember !== false,
    },
    signal,
  );
  return { sessionId, temporary: true };
}

async function rememberedSshNameForDatabase(
  taskId: string,
  preferredName: string | undefined,
  remember: boolean,
  deps: DatabaseToolDeps,
) {
  const state = await deps.sshRemoteState(taskId);
  if (state.profile) return state.profile.name;
  if (!remember) return preferredName;
  const adopted = await deps.adoptActiveSshRemote(taskId, "~", preferredName);
  return adopted.profile?.remembered ? adopted.profile.name : undefined;
}

async function rememberDatabaseCredential(
  kind: DatabaseKind,
  callInput: Record<string, unknown>,
  connectionInput: DatabaseConnectInput,
  result: Record<string, unknown>,
  viaSsh: boolean,
  deps: DatabaseToolDeps,
  source?: CredentialDescriptor,
  sshCredentialName?: string,
) {
  if (source || callInput.remember === false) return { credential: source };
  try {
    return {
      credential: await deps.saveCredentialProfile({
        kind,
        name:
          typeof callInput.name === "string"
            ? callInput.name.trim()
            : undefined,
        host: String(result.host || connectionInput.host || ""),
        port: Number(result.port || connectionInput.port || 0) || undefined,
        username: String(connectionInput.username || ""),
        database: String(result.database || connectionInput.database || ""),
        viaSsh,
        sshCredentialName: sshCredentialName || undefined,
        payload: Object.fromEntries(
          Object.entries(connectionInput).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      }),
    };
  } catch (error) {
    return {
      warning: `连接已成功，但凭据未能保存：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function connectionResultOutput(
  result: Record<string, unknown>,
  persistence?: {
    credential?: CredentialDescriptor;
    warning?: string;
  },
) {
  return JSON.stringify(
    {
      ...result,
      credential: publicCredentialReference(persistence?.credential),
      credentialWarning: persistence?.warning,
    },
    null,
    2,
  );
}

const VIA_SSH_LABEL: Record<DatabaseKind, string> = {
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
};

async function connectDatabase(
  kind: DatabaseKind,
  ctx: DatabaseToolContext,
  deps: DatabaseToolDeps,
  viaSsh: boolean,
) {
  const credential = await databaseCredentialInput(kind, ctx.input, deps);
  if (!viaSsh && credential.source?.viaSsh)
    throw new Error(
      `${VIA_SSH_LABEL[kind]} 凭据“${credential.source.name}”需要通过 SSH 连接，请使用 ${VIA_SSH_LABEL[kind]} SSH 连接工具。`,
    );
  const defaultHost = viaSsh ? "127.0.0.1" : "";
  const connectionInput =
    kind === "mysql"
      ? mysqlConnectInput(credential.input, defaultHost)
      : kind === "sqlserver"
        ? sqlServerConnectInput(credential.input, defaultHost)
        : mongoConnectInput(credential.input, defaultHost);
  const connect =
    kind === "mysql"
      ? deps.connectMysql
      : kind === "sqlserver"
        ? deps.connectSqlServer
        : deps.connectMongo;
  const adoptDb =
    kind === "mysql"
      ? deps.adoptMysqlSession
      : kind === "sqlserver"
        ? deps.adoptSqlServerSession
        : deps.adoptMongoSession;
  const disconnectDb =
    kind === "mysql"
      ? deps.disconnectMysql
      : kind === "sqlserver"
        ? deps.disconnectSqlServer
        : deps.disconnectMongo;
  let result: Record<string, unknown>;
  let preparedSsh: PreparedDatabaseSsh | undefined;
  if (viaSsh) {
    preparedSsh = await prepareDatabaseSsh(
      ctx.browserSessionId,
      ctx.requestId,
      ctx.activityId,
      ctx.input,
      credential.source?.sshCredentialName,
      ctx.signal,
      ctx.remoteWorkspaceRoot,
      deps,
    );
    result = await connectWithPreparedSsh({
      prepared: preparedSsh,
      connect: (sessionId) =>
        connect(sessionId, ctx.requestId, connectionInput as never, true, ctx.signal),
      adopt: (sessionId) => {
        adoptDb(sessionId, ctx.browserSessionId);
        deps.adoptSshSession(sessionId, ctx.browserSessionId);
      },
      cleanup: async (sessionId) => {
        await disconnectDb(sessionId);
        deps.disconnectSsh(sessionId);
      },
    });
  } else {
    result = await connect(
      ctx.browserSessionId,
      ctx.requestId,
      connectionInput as never,
      false,
      ctx.signal,
    );
  }
  const sshCredentialName = viaSsh
    ? await rememberedSshNameForDatabase(
        ctx.browserSessionId,
        preparedSsh?.credentialName,
        ctx.input.remember !== false,
        deps,
      )
    : undefined;
  const remembered = await rememberDatabaseCredential(
    kind,
    ctx.input,
    connectionInput,
    result,
    viaSsh,
    deps,
    credential.source,
    sshCredentialName,
  );
  return { output: connectionResultOutput(result, remembered) };
}

export async function executeDatabaseTool(
  ctx: DatabaseToolContext,
  deps?: DatabaseToolDeps,
): Promise<ToolResult> {
  const resolved = deps ?? productionDatabaseDeps();
  const { browserSessionId, requestId, name, input, signal } = ctx;
  if (name === "mysql_connect")
    return connectDatabase("mysql", ctx, resolved, false);
  if (name === "mysql_connect_via_ssh")
    return connectDatabase("mysql", ctx, resolved, true);
  if (name === "mysql_query") {
    const sql = String(input.sql || "");
    const risk = resolved.classifyMysqlSql(sql);
    return executeSqlQuery(
      browserSessionId,
      requestId,
      input,
      signal,
      (session, id, queryInput, abort) =>
        resolved.queryMysql(
          session,
          id,
          String(queryInput.sql),
          queryInput.values,
          abort,
        ),
      risk !== "read",
      (query, output) =>
        risk !== "read" &&
        (isSchemaMutationSql(query) || mutationChangedFromOutput(output)),
    );
  }
  if (name === "mysql_disconnect")
    return disconnectDatabase(browserSessionId, resolved.disconnectMysql, "MySQL");
  if (name === "sqlserver_connect")
    return connectDatabase("sqlserver", ctx, resolved, false);
  if (name === "sqlserver_connect_via_ssh")
    return connectDatabase("sqlserver", ctx, resolved, true);
  if (name === "sqlserver_query") {
    const sql = String(input.sql || "");
    const risk = resolved.classifySqlServerSql(sql);
    return executeSqlQuery(
      browserSessionId,
      requestId,
      input,
      signal,
      (session, id, queryInput, abort) =>
        resolved.querySqlServer(
          session,
          id,
          String(queryInput.sql),
          queryInput.values,
          abort,
        ),
      risk !== "read",
      (query, output) =>
        risk !== "read" &&
        (isSchemaMutationSql(query) || mutationChangedFromOutput(output)),
    );
  }
  if (name === "sqlserver_disconnect")
    return disconnectDatabase(
      browserSessionId,
      resolved.disconnectSqlServer,
      "SQL Server",
    );
  if (name === "mongodb_connect")
    return connectDatabase("mongodb", ctx, resolved, false);
  if (name === "mongodb_connect_via_ssh")
    return connectDatabase("mongodb", ctx, resolved, true);
  if (name === "mongodb_execute") {
    const operation = String(input.operation || "");
    const output = await resolved.executeMongo(
      browserSessionId,
      requestId,
      input as MongoOperationInput,
      signal,
    );
    return mongoOperationResult(operation, output);
  }
  if (name === "mongodb_disconnect")
    return disconnectDatabase(
      browserSessionId,
      resolved.disconnectMongo,
      "MongoDB",
    );
  throw new Error(`不支持的数据库工具：${name}`);
}
