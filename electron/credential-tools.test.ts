import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialDescriptor } from "./credential-vault";
import {
  currentBrowserWebsiteOrigin,
  executeCredentialTool,
  listedCredentials,
  parsedCredentialKind,
  publicCredentialReference,
  publicSshCredentialReference,
  savedSshCredential,
  sameWebsiteOrigin,
  type BrowserOriginDeps,
  type CredentialVaultDeps,
  type SshCredentialProfile,
} from "./credential-tools";

function selectByName<T extends { id: string; name: string }>(
  candidates: readonly T[],
  selector: string,
  label = "",
) {
  const query = selector.trim();
  if (!query) throw new Error(`缺少${label}凭据名称。`);
  const exact = candidates.filter(
    (item) => item.id === query || item.name === query,
  );
  if (exact.length === 1) return exact[0];
  throw new Error(`本地没有已保存的${label}凭据“${selector}”，请提供新的连接信息。`);
}

function descriptor(
  partial: Partial<CredentialDescriptor> &
    Pick<CredentialDescriptor, "id" | "kind" | "name">,
): CredentialDescriptor {
  return {
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function memoryVault(): CredentialVaultDeps & {
  credentials: CredentialDescriptor[];
  ssh: SshCredentialProfile[];
  forgotten: string[];
} {
  const credentials: CredentialDescriptor[] = [];
  const ssh: SshCredentialProfile[] = [];
  const forgotten: string[] = [];
  return {
    credentials,
    ssh,
    forgotten,
    async listCredentialProfiles(kind, query = "") {
      const needle = query.trim().toLocaleLowerCase();
      return credentials.filter((item) => {
        if (kind && item.kind !== kind) return false;
        if (!needle) return true;
        return [item.name, item.host, item.username, item.url]
          .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
      });
    },
    async listSshRemoteProfiles() {
      return ssh;
    },
    async saveCredentialProfile(input) {
      const saved = descriptor({
        id: `cred-${credentials.length + 1}`,
        kind: input.kind,
        name: input.name || input.username || "saved",
        url: input.url,
        username: input.username,
      });
      credentials.push(saved);
      return saved;
    },
    async forgetCredentialProfile(kind, selector) {
      const index = credentials.findIndex(
        (item) => item.kind === kind && item.name === selector,
      );
      if (index < 0) throw new Error(`没有凭据 ${selector}`);
      const [removed] = credentials.splice(index, 1);
      forgotten.push(removed.id);
      return removed;
    },
    async forgetSshRemoteProfile(profileId) {
      const index = ssh.findIndex((item) => item.id === profileId);
      if (index < 0) throw new Error(`没有 SSH ${profileId}`);
      forgotten.push(profileId);
      ssh.splice(index, 1);
    },
    selectCredential: selectByName,
    async resolveCredentialProfile() {
      throw new Error("unused");
    },
  };
}

function originAt(url: string, open = true): BrowserOriginDeps {
  return {
    browserIsOpen: () => open,
    browserSessionUrl: () => url,
  };
}

test("parsedCredentialKind accepts known kinds and rejects others", () => {
  assert.equal(parsedCredentialKind(undefined), undefined);
  assert.equal(parsedCredentialKind("website"), "website");
  assert.equal(parsedCredentialKind("ssh"), "ssh");
  assert.throws(() => parsedCredentialKind("ftp"), /不支持的凭据类型/);
});

test("listedCredentials merges SSH and vault records then filters", async () => {
  const vault = memoryVault();
  vault.ssh.push({
    id: "ssh-1",
    name: "prod",
    host: "ssh.example.com",
    port: 22,
    username: "root",
    rootPath: "/srv",
    remembered: true,
  });
  vault.credentials.push(
    descriptor({
      id: "db-1",
      kind: "mysql",
      name: "app-db",
      host: "db.example.com",
      username: "app",
    }),
  );
  const allSsh = await listedCredentials("ssh", "", vault);
  assert.equal(allSsh.length, 1);
  assert.equal(allSsh[0].kind, "ssh");
  assert.equal(allSsh[0].database, "/srv");
  const mysql = await listedCredentials("mysql", "app", vault);
  assert.equal(mysql.length, 1);
  assert.equal(mysql[0].name, "app-db");
  const missed = await listedCredentials("ssh", "nope", vault);
  assert.equal(missed.length, 0);
});

test("credential_list requires a kind and hides timestamps", async () => {
  const vault = memoryVault();
  vault.credentials.push(
    descriptor({
      id: "web-1",
      kind: "website",
      name: "login",
      url: "https://example.com",
      username: "alice",
    }),
  );
  await assert.rejects(
    () => executeCredentialTool("credential_list", {}, "session", vault),
    /缺少凭据类型/,
  );
  const result = await executeCredentialTool(
    "credential_list",
    { kind: "website" },
    "session",
    vault,
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.secretsReturned, false);
  assert.equal(parsed.credentials[0].name, "login");
  assert.equal(parsed.credentials[0].createdAt, undefined);
});

test("browser credential list and save stay on the current origin", async () => {
  const vault = memoryVault();
  vault.credentials.push(
    descriptor({
      id: "same",
      kind: "website",
      name: "same-site",
      url: "https://app.example.com/login",
      username: "alice",
    }),
    descriptor({
      id: "other",
      kind: "website",
      name: "other-site",
      url: "https://other.example.com",
      username: "bob",
    }),
  );
  const listed = await executeCredentialTool(
    "browser_list_credentials",
    {},
    "session",
    vault,
    originAt("https://app.example.com/dashboard"),
  );
  const parsed = JSON.parse(listed.output);
  assert.equal(parsed.origin, "https://app.example.com");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.credentials[0].name, "same-site");

  const saved = await executeCredentialTool(
    "browser_save_credential",
    { username: "carol", password: "secret", name: "carol-login" },
    "session",
    vault,
    originAt("https://app.example.com/form"),
  );
  const savedParsed = JSON.parse(saved.output);
  assert.equal(savedParsed.saved, true);
  assert.equal(savedParsed.url, "https://app.example.com");
  assert.equal(savedParsed.username, "carol");
  assert.deepEqual(savedParsed.credential, {
    kind: "website",
    name: "carol-login",
    stored: true,
  });
});

test("credential_save rejects non-website kinds and mismatched legacy urls", async () => {
  const vault = memoryVault();
  await assert.rejects(
    () =>
      executeCredentialTool(
        "credential_save",
        { kind: "mysql", username: "a", password: "b" },
        "session",
        vault,
        originAt("https://example.com"),
      ),
    /数据库和 SSH 凭据必须在连接成功后由连接工具保存/,
  );
  await assert.rejects(
    () =>
      executeCredentialTool(
        "credential_save",
        {
          username: "a",
          password: "b",
          url: "https://other.example.com",
        },
        "session",
        vault,
        originAt("https://example.com"),
      ),
    /旧版凭据调用指定的网站与当前浏览器页面不一致/,
  );
  await assert.rejects(
    () =>
      executeCredentialTool(
        "browser_save_credential",
        { username: "a" },
        "session",
        vault,
        originAt("https://example.com"),
      ),
    /缺少网站账号或密码/,
  );
});

test("credential_forget deletes SSH and vault records", async () => {
  const vault = memoryVault();
  vault.ssh.push({
    id: "ssh-9",
    name: "jump",
    host: "jump.example.com",
    port: 22,
    username: "ops",
    rootPath: "~",
    remembered: true,
  });
  vault.credentials.push(
    descriptor({ id: "web-9", kind: "website", name: "portal" }),
  );
  const ssh = await executeCredentialTool(
    "credential_forget",
    { kind: "ssh", name: "jump" },
    "session",
    vault,
  );
  assert.deepEqual(JSON.parse(ssh.output), {
    deleted: true,
    kind: "ssh",
    name: "jump",
  });
  const website = await executeCredentialTool(
    "credential_forget",
    { kind: "website", name: "portal" },
    "session",
    vault,
  );
  assert.deepEqual(JSON.parse(website.output), {
    deleted: true,
    kind: "website",
    name: "portal",
  });
  assert.deepEqual(vault.forgotten, ["ssh-9", "web-9"]);
});

test("website origin helpers reject closed or non-http sessions", () => {
  assert.equal(
    sameWebsiteOrigin("https://a.example/x", "https://a.example/y"),
    true,
  );
  assert.equal(
    sameWebsiteOrigin("https://a.example", "https://b.example"),
    false,
  );
  assert.throws(
    () => currentBrowserWebsiteOrigin("session", originAt("https://x", false)),
    /当前任务没有打开网页/,
  );
  assert.throws(
    () =>
      currentBrowserWebsiteOrigin(
        "session",
        originAt("file:///tmp/page.html"),
      ),
    /不是可保存凭据的 HTTP\/HTTPS 网站/,
  );
});

test("saved SSH lookup and public references keep stored flags", async () => {
  const vault = memoryVault();
  vault.ssh.push({
    id: "ssh-2",
    name: "bastion",
    host: "bastion.example.com",
    port: 22,
    username: "ops",
    rootPath: "/opt",
    remembered: false,
  });
  const saved = await savedSshCredential("bastion", vault);
  assert.equal(saved.id, "ssh-2");
  assert.deepEqual(publicSshCredentialReference(saved), {
    kind: "ssh",
    name: "bastion",
    stored: false,
  });
  assert.equal(publicCredentialReference(), undefined);
});

test("rejects unknown credential tools", async () => {
  await assert.rejects(
    () =>
      executeCredentialTool(
        "credential_rotate",
        {},
        "session",
        memoryVault(),
        originAt("https://example.com"),
      ),
    /不支持的凭据工具/,
  );
});
