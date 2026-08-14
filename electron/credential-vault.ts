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

export const credentialKinds = [
  "mysql",
  "sqlserver",
  "mongodb",
  "website",
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

const credentialKindNames: Record<CredentialKind, string> = {
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
  website: "网站",
};

export type CredentialDescriptor = {
  id: string;
  kind: CredentialKind;
  name: string;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  url?: string;
  viaSsh?: boolean;
  sshCredentialName?: string;
  createdAt: number;
  updatedAt: number;
};

type StoredCredential = CredentialDescriptor & {
  encryptedPayload: string;
};

export type ResolvedCredential = {
  descriptor: CredentialDescriptor;
  payload: Record<string, unknown>;
};

export type SaveCredentialInput = Omit<
  CredentialDescriptor,
  "id" | "name" | "createdAt" | "updatedAt"
> & {
  name?: string;
  payload: Record<string, unknown>;
};

type SelectableCredential = Pick<
  CredentialDescriptor,
  "id" | "name" | "host" | "username" | "database" | "url"
>;

const credentials = new Map<string, StoredCredential>();
let loaded = false;
let mutationQueue = Promise.resolve();

const vaultPath = () =>
  path.join(app.getPath("userData"), "credential-vault.json");

function clean(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalized(value: unknown) {
  return clean(value, 500).toLocaleLowerCase();
}

function publicCredential(value: StoredCredential): CredentialDescriptor {
  const { encryptedPayload: _encryptedPayload, ...descriptor } = value;
  return descriptor;
}

function websiteOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("网站凭据需要有效的 HTTP/HTTPS 地址。");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("网站凭据地址必须是不含账号密码的 HTTP/HTTPS 地址。");
  return url.origin;
}

function generatedName(input: SaveCredentialInput) {
  if (input.kind === "website") {
    const origin = input.url ? websiteOrigin(input.url) : "网站账号";
    return input.username ? `${origin} · ${input.username}` : origin;
  }
  const endpoint = input.host || input.kind;
  const account = input.username ? `${input.username}@` : "";
  const database = input.database ? `/${input.database}` : "";
  return `${account}${endpoint}${database}`;
}

function validateDescriptor(input: SaveCredentialInput) {
  const name = clean(input.name || generatedName(input), 160);
  if (!name) throw new Error("凭据名称不能为空。");
  const host = input.host ? clean(input.host, 255) : undefined;
  const username = input.username ? clean(input.username, 320) : undefined;
  const database = input.database ? clean(input.database, 255) : undefined;
  const sshCredentialName = input.sshCredentialName
    ? clean(input.sshCredentialName, 160)
    : undefined;
  const url = input.url ? websiteOrigin(input.url) : undefined;
  const port = input.port === undefined ? undefined : Number(input.port);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65_535)
  )
    throw new Error("凭据端口必须是 1 到 65535 之间的整数。");
  if (input.kind === "website" && (!url || !username))
    throw new Error("网站凭据必须包含网站地址和账号。");
  if (input.kind !== "website" && !host)
    throw new Error("数据库凭据必须包含服务器地址。");
  if ((input.kind === "mysql" || input.kind === "sqlserver") && !username)
    throw new Error("数据库凭据必须包含服务器地址和用户名。");
  return {
    name,
    host,
    port,
    username,
    database,
    url,
    viaSsh: Boolean(input.viaSsh),
    sshCredentialName,
  };
}

function encryptPayload(payload: Record<string, unknown>) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("当前系统无法安全保存凭据。");
  return safeStorage.encryptString(JSON.stringify(payload)).toString("base64");
}

function decryptPayload(value: StoredCredential) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("当前系统暂时无法解密已保存的凭据。");
  const plain = safeStorage.decryptString(
    Buffer.from(value.encryptedPayload, "base64"),
  );
  const parsed = JSON.parse(plain) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`已保存凭据“${value.name}”的数据格式无效。`);
  return parsed as Record<string, unknown>;
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(await readFile(vaultPath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== "object") continue;
      const value = candidate as Partial<StoredCredential>;
      if (
        typeof value.id !== "string" ||
        !credentialKinds.includes(value.kind as CredentialKind) ||
        typeof value.name !== "string" ||
        typeof value.encryptedPayload !== "string"
      )
        continue;
      credentials.set(value.id, value as StoredCredential);
    }
  } catch {
    // First use, a manually removed file, or an unreadable legacy file.
  }
}

async function persist() {
  const target = vaultPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporary,
      JSON.stringify([...credentials.values()], null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function serializeMutation<T>(operation: () => Promise<T>) {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function selectCredential<T extends SelectableCredential>(
  candidates: readonly T[],
  selector: string,
  label = "",
) {
  const query = normalized(selector);
  if (!query) throw new Error(`缺少${label}凭据名称。`);
  const endpoint = (item: T) =>
    normalized(
      `${item.username ? `${item.username}@` : ""}${item.host || item.url || ""}${item.database ? `/${item.database}` : ""}`,
    );
  const exact = candidates.filter(
    (item) =>
      normalized(item.id) === query ||
      normalized(item.name) === query ||
      normalized(item.host) === query ||
      endpoint(item) === query,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1)
    throw new Error(
      `${label}凭据“${selector}”匹配到多条记录，请使用完整别名。`,
    );
  const fuzzy = candidates.filter(
    (item) =>
      normalized(item.name).includes(query) ||
      normalized(item.host).includes(query) ||
      normalized(item.database).includes(query) ||
      normalized(item.url).includes(query) ||
      endpoint(item).includes(query),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1)
    throw new Error(
      `${label}凭据“${selector}”匹配到多条记录，请使用完整别名。`,
    );
  throw new Error(
    `本地没有已保存的${label}凭据“${selector}”，请提供新的连接信息。`,
  );
}

export async function listCredentialProfiles(
  kind?: CredentialKind,
  query = "",
) {
  await ensureLoaded();
  const needle = normalized(query);
  return [...credentials.values()]
    .filter((item) => !kind || item.kind === kind)
    .map(publicCredential)
    .filter(
      (item) =>
        !needle ||
        [
          item.name,
          item.host,
          item.username,
          item.database,
          item.url,
          item.sshCredentialName,
        ].some((value) => normalized(value).includes(needle)),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function resolveCredentialProfile(
  kind: CredentialKind,
  selector: string,
): Promise<ResolvedCredential> {
  const candidates = await listCredentialProfiles(kind);
  const descriptor = selectCredential(
    candidates,
    selector,
    `${credentialKindNames[kind]} `,
  );
  const stored = credentials.get(descriptor.id);
  if (!stored) throw new Error(`已保存凭据“${descriptor.name}”不存在。`);
  return { descriptor, payload: decryptPayload(stored) };
}

export async function saveCredentialProfile(input: SaveCredentialInput) {
  return serializeMutation(async () => {
    await ensureLoaded();
    const descriptor = validateDescriptor(input);
    const now = Date.now();
    const previous = [...credentials.values()].find(
      (item) =>
        item.kind === input.kind &&
        normalized(item.name) === normalized(descriptor.name),
    );
    const stored: StoredCredential = {
      id: previous?.id || randomUUID(),
      kind: input.kind,
      ...descriptor,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      encryptedPayload: encryptPayload(input.payload),
    };
    credentials.set(stored.id, stored);
    try {
      await persist();
    } catch (error) {
      if (previous) credentials.set(previous.id, previous);
      else credentials.delete(stored.id);
      throw new Error(
        `无法保存凭据“${stored.name}”：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return publicCredential(stored);
  });
}

export async function forgetCredentialProfile(
  kind: CredentialKind,
  selector: string,
) {
  return serializeMutation(async () => {
    await ensureLoaded();
    const descriptor = selectCredential(
      await listCredentialProfiles(kind),
      selector,
      `${credentialKindNames[kind]} `,
    );
    const previous = credentials.get(descriptor.id);
    credentials.delete(descriptor.id);
    try {
      await persist();
    } catch (error) {
      if (previous) credentials.set(previous.id, previous);
      throw error;
    }
    return descriptor;
  });
}

export async function resetCredentialVaultForTests() {
  await mutationQueue;
  credentials.clear();
  loaded = false;
  mutationQueue = Promise.resolve();
  await unlink(vaultPath()).catch(() => undefined);
}
