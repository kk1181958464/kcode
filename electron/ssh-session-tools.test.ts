import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSshTool,
  type SshRemoteProfileInfo,
  type SshRemoteStateInfo,
  type SshToolContext,
  type SshToolDeps,
} from "./ssh-session-tools";
function profile(
  partial: Partial<SshRemoteProfileInfo> = {},
): SshRemoteProfileInfo {
  return {
    id: "p1",
    name: "prod",
    host: "203.0.113.9",
    port: 22,
    username: "deploy",
    rootPath: "/srv/app",
    remembered: true,
    ...partial,
  };
}

function memorySsh(overrides: Partial<SshToolDeps> = {}): SshToolDeps & {
  calls: string[];
  files: { name: string; path?: string }[];
  state: SshRemoteStateInfo;
} {
  const calls: string[] = [];
  const files: { name: string; path?: string }[] = [];
  const current = profile();
  const state: SshRemoteStateInfo = {
    connected: true,
    profile: current,
  };
  return {
    calls,
    files,
    state,
    async savedSshCredential(selector) {
      calls.push(`saved:${selector}`);
      if (selector !== "prod") throw new Error(`没有 SSH 凭据 ${selector}`);
      return current;
    },
    async connectSavedSshRemote(taskId, profileId, rootPath) {
      calls.push(`connectSaved:${taskId}:${profileId}:${rootPath ?? ""}`);
      state.connected = true;
      if (rootPath) state.profile = { ...current, rootPath };
      return state;
    },
    async sshRemoteState() {
      return state;
    },
    async privateKeyForSshTool(input) {
      calls.push(`key:${String(input.privateKeyPath || input.privateKey || "")}`);
      return typeof input.privateKey === "string" ? input.privateKey : "KEY";
    },
    async connectSsh(sessionId, requestId, input) {
      calls.push(`connect:${sessionId}:${requestId}:${input.host}`);
      state.connected = true;
      return {
        connected: true,
        host: input.host,
        port: input.port,
        username: input.username,
      };
    },
    async resolveSshRoot(_sessionId, _requestId, requestedPath) {
      calls.push(`root:${requestedPath}`);
      if (requestedPath === "/missing") throw new Error("no such path");
      return requestedPath === "~" ? "/home/deploy" : requestedPath;
    },
    async adoptActiveSshRemote(taskId, requestedRootPath, preferredName) {
      calls.push(`adopt:${taskId}:${requestedRootPath}:${preferredName ?? ""}`);
      const rootPath = requestedRootPath || current.rootPath;
      state.profile = { ...current, rootPath, name: preferredName || current.name };
      return state;
    },
    async runSshCommand(_sessionId, _requestId, command, _signal, options) {
      calls.push(`run:${command}`);
      options.onOutput?.("partial");
      return { output: "ok", exitCode: 0 };
    },
    disconnectSsh(sessionId) {
      calls.push(`disconnect:${sessionId}`);
      const was = state.connected;
      state.connected = false;
      return was;
    },
    async executeSshFileOperation(ctx) {
      files.push({ name: ctx.toolName, path: String(ctx.input.path || "") });
      return {
        output: `${ctx.toolName}:${ctx.remoteRootPath}:${ctx.input.path}`,
        path: String(ctx.input.path || ""),
      };
    },
    ...overrides,
  };
}

function ctx(
  name: string,
  input: Record<string, unknown>,
  extra: Partial<SshToolContext> = {},
): SshToolContext {
  return {
    root: "/ws",
    browserSessionId: "task-1",
    requestId: "req-1",
    activityId: "act-1",
    name,
    input,
    messages: [{ role: "user", content: "connect" }],
    signal: new AbortController().signal,
    diffFor: () => ({ diff: "", additions: 0, deletions: 0 }),
    ...extra,
  };
}

test("ssh_connect uses a saved credential without opening a live session", async () => {
  const deps = memorySsh();
  const result = await executeSshTool(
    ctx("ssh_connect", { credentialName: "prod", rootPath: "/opt/app" }),
    deps,
  );
  assert.equal(result.path, "/opt/app");
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.host, "203.0.113.9");
  assert.equal(parsed.rootPath, "/opt/app");
  assert.deepEqual(parsed.credential, {
    kind: "ssh",
    name: "prod",
    stored: true,
  });
  assert.deepEqual(deps.calls, [
    "saved:prod",
    "connectSaved:task-1:p1:/opt/app",
  ]);
});

test("ssh_connect falls back to home when the requested root is missing", async () => {
  const deps = memorySsh();
  const result = await executeSshTool(
    ctx("ssh_connect", {
      host: "10.0.0.8",
      username: "root",
      password: "x",
      rootPath: "/missing",
      name: "box",
    }),
    deps,
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.rootPath, "/home/deploy");
  assert.match(parsed.rootPathWarning, /\/missing/);
  assert.equal(parsed.credential.name, "box");
  assert.ok(deps.calls.includes("root:/missing"));
  assert.ok(deps.calls.includes("root:~"));
});

test("ssh_run prefixes the workspace and records inspect evidence", async () => {
  const deps = memorySsh();
  const progress: string[] = [];
  const result = await executeSshTool(
    {
      ...ctx("ssh_run", { command: "ls -la", purpose: "inspect" }),
      onProgress: (output) => progress.push(output),
    },
    deps,
  );
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.command, "cd -- '/srv/app' && (ls -la)");
  assert.deepEqual(result.operationEvidence, ["execute", "inspect"]);
  assert.deepEqual(progress, ["partial"]);
});

test("ssh file tools keep the active remote root", async () => {
  const deps = memorySsh();
  const result = await executeSshTool(
    ctx("ssh_read_file", { path: "README.md" }),
    deps,
  );
  assert.equal(result.output, "ssh_read_file:/srv/app:README.md");
  assert.deepEqual(deps.files, [{ name: "ssh_read_file", path: "README.md" }]);
});

test("ssh_disconnect reports whether a session existed", async () => {
  const deps = memorySsh();
  const closed = await executeSshTool(ctx("ssh_disconnect", {}), deps);
  assert.equal(closed.output, "SSH 连接已断开");
  const again = await executeSshTool(ctx("ssh_disconnect", {}), deps);
  assert.equal(again.output, "当前任务没有活动的 SSH 连接");
});

test("ssh_set_workspace adopts the resolved root", async () => {
  const deps = memorySsh();
  const result = await executeSshTool(
    ctx("ssh_set_workspace", { path: "/var/www" }),
    deps,
  );
  assert.equal(result.path, "/var/www");
  assert.equal(JSON.parse(result.output).rootPath, "/var/www");
});
