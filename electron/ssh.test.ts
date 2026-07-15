import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server, type Connection } from "ssh2";
import {
  configureSshKnownHosts,
  connectSsh,
  disconnectSsh,
  normalizeSshPrivateKey,
  redactSshInput,
  runSshCommand,
} from "./ssh";

test("normalizes escaped newlines in SSH private keys", () => {
  assert.equal(
    normalizeSshPrivateKey("-----BEGIN KEY-----\\nabc\\n-----END KEY-----"),
    "-----BEGIN KEY-----\nabc\n-----END KEY-----",
  );
});

test("redacts SSH credentials from persisted activity input", () => {
  assert.deepEqual(
    redactSshInput({
      host: "server.example.com",
      port: 2222,
      username: "deploy",
      password: "plain-password",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      passphrase: "key-passphrase",
      stdin: "sudo-password\n",
    }),
    {
      host: "server.example.com",
      port: 2222,
      username: "deploy",
      password: "[已隐藏]",
      privateKey: "[已隐藏]",
      passphrase: "[已隐藏]",
      stdin: "[已隐藏]",
    },
  );
});

test("persists TOFU fingerprints and preserves the old session on mismatch", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kcode-ssh-host-test-"));
  const knownHostsPath = path.join(directory, "known-hosts.json");
  configureSshKnownHosts(knownHostsPath);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clients = new Set<Connection>();
  const server = new Server(
    {
      hostKeys: [
        privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      ],
    },
    (client) => {
      clients.add(client);
      client.on("error", () => undefined);
      client.on("close", () => clients.delete(client));
      client.on("authentication", (context) => context.accept());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const input = {
    host: "127.0.0.1",
    port: address.port,
    username: "test",
    password: "test",
  };
  const first = await connectSsh(
    "fingerprint-task",
    "request-1",
    input,
    new AbortController().signal,
  );
  assert.equal(first.hostTrust, "trusted-on-first-use");
  assert.match(readFileSync(knownHostsPath, "utf8"), /127\.0\.0\.1/);
  const second = await connectSsh(
    "fingerprint-task",
    "request-2",
    input,
    new AbortController().signal,
  );
  assert.equal(second.hostTrust, "verified");
  await assert.rejects(
    connectSsh(
      "fingerprint-task",
      "request-3",
      { ...input, hostFingerprint: "0".repeat(64) },
      new AbortController().signal,
    ),
    /指纹不匹配/,
  );
  assert.equal(disconnectSsh("fingerprint-task"), true);
  for (const client of clients) client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

test("cancels a pending SSH handshake without registering a session", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kcode-ssh-test-"));
  configureSshKnownHosts(path.join(directory, "known-hosts.json"));
  let closeSocket: (() => void) | undefined;
  let socketClosed: Promise<void> | undefined;
  let acceptSocket!: () => void;
  const socketAccepted = new Promise<void>((resolve) => {
    acceptSocket = resolve;
  });
  const server = createServer((socket) => {
    closeSocket = () => socket.destroy();
    socketClosed = new Promise((resolve) => socket.once("close", resolve));
    acceptSocket();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  const connecting = connectSsh(
    "cancel-task",
    "cancel-request",
    {
      host: "127.0.0.1",
      port: address.port,
      username: "test",
      password: "test",
    },
    controller.signal,
  );
  await socketAccepted;
  controller.abort();
  await assert.rejects(connecting, /已取消/);
  assert.equal(disconnectSsh("cancel-task"), false);
  const closedQuickly = await Promise.race([
    socketClosed?.then(() => true) ?? Promise.resolve(false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  closeSocket?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(closedQuickly, true);
  rmSync(directory, { recursive: true, force: true });
});

test("supports keyboard-interactive auth and times out stalled commands", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "kcode-ssh-keyboard-test-"),
  );
  configureSshKnownHosts(path.join(directory, "known-hosts.json"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clients = new Set<Connection>();
  const server = new Server(
    {
      hostKeys: [
        privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      ],
    },
    (client) => {
      clients.add(client);
      client.on("error", () => undefined);
      client.on("close", () => clients.delete(client));
      client.on("authentication", (context) => {
        if (context.method !== "keyboard-interactive")
          return context.reject(["keyboard-interactive"]);
        context.prompt(
          [{ prompt: "Password: ", echo: false }],
          (answers: string[]) =>
            answers[0] === "test-password"
              ? context.accept()
              : context.reject(),
        );
      });
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptCommand) => {
            const stream = acceptCommand();
            stream.write("remote command started\n");
          });
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await connectSsh(
    "keyboard-task",
    "keyboard-request",
    {
      host: "127.0.0.1",
      port: address.port,
      username: "test",
      password: "test-password",
    },
    new AbortController().signal,
  );
  assert.equal(result.connected, true);
  const progress: string[] = [];
  await assert.rejects(
    runSshCommand(
      "keyboard-task",
      "keyboard-command",
      "sleep forever",
      new AbortController().signal,
      { timeoutMs: 25, onOutput: (output) => progress.push(output) },
    ),
    /远程命令执行超时/,
  );
  assert.ok(
    progress.some((output) => output.includes("remote command started")),
  );
  assert.equal(disconnectSsh("keyboard-task"), true);
  for (const client of clients) client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});
