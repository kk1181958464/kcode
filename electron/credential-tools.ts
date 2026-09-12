import { createRequire } from "node:module";
import type { ToolResult } from "./agent-types";
import type {
  CredentialDescriptor,
  CredentialKind,
  ResolvedCredential,
  SaveCredentialInput,
} from "./credential-vault";

const requireProduction = createRequire(__filename);

export type ToolCredentialKind = CredentialKind | "ssh";

export type PublicToolCredential = Omit<CredentialDescriptor, "kind"> & {
  kind: ToolCredentialKind;
};

export type SshCredentialProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  rootPath: string;
  remembered: boolean;
};

export type CredentialVaultDeps = {
  listCredentialProfiles: (
    kind?: CredentialKind,
    query?: string,
  ) => Promise<CredentialDescriptor[]>;
  listSshRemoteProfiles: () => Promise<SshCredentialProfile[]>;
  saveCredentialProfile: (
    input: SaveCredentialInput,
  ) => Promise<CredentialDescriptor>;
  forgetCredentialProfile: (
    kind: CredentialKind,
    selector: string,
  ) => Promise<CredentialDescriptor>;
  forgetSshRemoteProfile: (profileId: string) => Promise<unknown>;
  selectCredential: (
    candidates: readonly SshCredentialProfile[],
    selector: string,
    label?: string,
  ) => SshCredentialProfile;
  resolveCredentialProfile: (
    kind: CredentialKind,
    selector: string,
  ) => Promise<ResolvedCredential>;
};

export type BrowserOriginDeps = {
  browserIsOpen: (sessionId: string) => boolean;
  browserSessionUrl: (sessionId: string) => string;
};

const credentialKindLabels: Record<ToolCredentialKind, string> = {
  ssh: "SSH",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
  website: "网站",
};

function productionVault(): CredentialVaultDeps {
  const vault = requireProduction("./credential-vault") as typeof import("./credential-vault");
  const ssh = requireProduction("./ssh-remote") as typeof import("./ssh-remote");
  return {
    listCredentialProfiles: vault.listCredentialProfiles,
    listSshRemoteProfiles: ssh.listSshRemoteProfiles,
    saveCredentialProfile: vault.saveCredentialProfile,
    forgetCredentialProfile: vault.forgetCredentialProfile,
    forgetSshRemoteProfile: ssh.forgetSshRemoteProfile,
    selectCredential: vault.selectCredential,
    resolveCredentialProfile: vault.resolveCredentialProfile,
  };
}

function productionOrigin(): BrowserOriginDeps {
  const browser = requireProduction("./browser") as typeof import("./browser");
  return {
    browserIsOpen: browser.browserIsOpen,
    browserSessionUrl: browser.browserSessionUrl,
  };
}

export function parsedCredentialKind(
  value: unknown,
): ToolCredentialKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const kind = String(value) as ToolCredentialKind;
  if (!(kind in credentialKindLabels)) throw new Error("不支持的凭据类型。");
  return kind;
}

export function publicSshCredential(
  profile: SshCredentialProfile,
): PublicToolCredential {
  return {
    id: profile.id,
    kind: "ssh",
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.rootPath,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function credentialMatchesQuery(
  item: PublicToolCredential,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    item.name,
    item.host,
    item.username,
    item.database,
    item.url,
    item.sshCredentialName,
  ].some((value) =>
    String(value || "")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export async function listedCredentials(
  kind?: ToolCredentialKind,
  query = "",
  vault: CredentialVaultDeps = productionVault(),
): Promise<PublicToolCredential[]> {
  const databaseCredentials =
    kind === "ssh"
      ? []
      : await vault.listCredentialProfiles(
          kind as CredentialKind | undefined,
          query,
        );
  const sshCredentials =
    kind && kind !== "ssh"
      ? []
      : (await vault.listSshRemoteProfiles())
          .map(publicSshCredential)
          .filter((item) => credentialMatchesQuery(item, query));
  return [...sshCredentials, ...databaseCredentials].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}

export async function savedSshCredential(
  selector: string,
  vault: Pick<
    CredentialVaultDeps,
    "listSshRemoteProfiles" | "selectCredential"
  > = productionVault(),
) {
  const profiles = await vault.listSshRemoteProfiles();
  return vault.selectCredential(profiles, selector, "SSH ");
}

export function publicCredentialReference(descriptor?: CredentialDescriptor) {
  return descriptor
    ? {
        kind: descriptor.kind,
        name: descriptor.name,
        stored: true,
      }
    : undefined;
}

export function publicSshCredentialReference(
  profile?: Pick<SshCredentialProfile, "name" | "remembered">,
) {
  return profile
    ? {
        kind: "ssh" as const,
        name: profile.name,
        stored: profile.remembered,
      }
    : undefined;
}

export function sameWebsiteOrigin(currentUrl: string, storedUrl: string) {
  try {
    return new URL(currentUrl).origin === new URL(storedUrl).origin;
  } catch {
    return false;
  }
}

export function currentBrowserWebsiteOrigin(
  browserSessionId: string,
  origin?: BrowserOriginDeps,
) {
  const resolvedOrigin = origin ?? productionOrigin();
  if (!resolvedOrigin.browserIsOpen(browserSessionId))
    throw new Error(
      "当前任务没有打开网页，无法把账号归类为网站凭据。请先打开目标网站；SSH 和数据库账号应使用对应连接工具。",
    );
  const currentUrl = resolvedOrigin.browserSessionUrl(browserSessionId);
  try {
    const url = new URL(currentUrl);
    if (!/^https?:$/.test(url.protocol))
      throw new Error("unsupported protocol");
    return url.origin;
  } catch {
    throw new Error("当前浏览器页面不是可保存凭据的 HTTP/HTTPS 网站。");
  }
}

function publicListedItem(item: PublicToolCredential) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = item;
  return rest;
}

export async function executeCredentialTool(
  name: string,
  input: Record<string, unknown>,
  browserSessionId: string,
  vault?: CredentialVaultDeps,
  origin?: BrowserOriginDeps,
): Promise<ToolResult> {
  if (name === "credential_list") {
    const kind = parsedCredentialKind(input.kind);
    if (!kind) throw new Error("缺少凭据类型。");
    const query = String(input.query || "").trim();
    const credentials = await listedCredentials(
      kind,
      query,
      vault ?? productionVault(),
    );
    return {
      output: JSON.stringify(
        {
          credentials: credentials.map(publicListedItem),
          count: credentials.length,
          secretsReturned: false,
        },
        null,
        2,
      ),
    };
  }
  if (name === "browser_list_credentials") {
    const resolvedVault = vault ?? productionVault();
    const pageOrigin = currentBrowserWebsiteOrigin(
      browserSessionId,
      origin ?? productionOrigin(),
    );
    const query = String(input.query || "").trim();
    const credentials = (
      await resolvedVault.listCredentialProfiles("website", query)
    ).filter(
      (credential) =>
        Boolean(credential.url) &&
        sameWebsiteOrigin(pageOrigin, credential.url!),
    );
    return {
      output: JSON.stringify(
        {
          origin: pageOrigin,
          credentials: credentials.map(publicListedItem),
          count: credentials.length,
          secretsReturned: false,
        },
        null,
        2,
      ),
    };
  }
  if (name === "browser_save_credential" || name === "credential_save") {
    if (
      name === "credential_save" &&
      input.kind !== undefined &&
      input.kind !== "website"
    )
      throw new Error("数据库和 SSH 凭据必须在连接成功后由连接工具保存。");
    const url = currentBrowserWebsiteOrigin(
      browserSessionId,
      origin ?? productionOrigin(),
    );
    const legacyUrl = String(input.url || "").trim();
    if (legacyUrl && !sameWebsiteOrigin(url, legacyUrl))
      throw new Error(
        "旧版凭据调用指定的网站与当前浏览器页面不一致，已拒绝保存。",
      );
    const username = String(input.username || "").trim();
    const password = String(input.password || "");
    if (!username || !password) throw new Error("缺少网站账号或密码。");
    const credential = await (vault ?? productionVault()).saveCredentialProfile({
      kind: "website",
      name: String(input.name || "").trim(),
      url,
      username,
      payload: { username, password },
    });
    return {
      output: JSON.stringify(
        {
          saved: true,
          credential: publicCredentialReference(credential),
          url: credential.url,
          username: credential.username,
        },
        null,
        2,
      ),
    };
  }
  if (name === "credential_forget") {
    const kind = parsedCredentialKind(input.kind);
    if (!kind) throw new Error("缺少凭据类型。");
    const selector = String(input.name || "").trim();
    const resolvedVault = vault ?? productionVault();
    if (kind === "ssh") {
      const profile = await savedSshCredential(selector, resolvedVault);
      await resolvedVault.forgetSshRemoteProfile(profile.id);
      return {
        output: JSON.stringify(
          { deleted: true, kind, name: profile.name },
          null,
          2,
        ),
      };
    }
    const profile = await resolvedVault.forgetCredentialProfile(kind, selector);
    return {
      output: JSON.stringify(
        { deleted: true, kind, name: profile.name },
        null,
        2,
      ),
    };
  }
  throw new Error(`不支持的凭据工具：${name}`);
}
