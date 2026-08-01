import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-remote-e2e-"));
const database = path.join(directory, "remote.sqlite");
const port = 18_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/server/index.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    KCODE_HOST: "127.0.0.1",
    KCODE_PORT: String(port),
    KCODE_DATABASE: database,
    KCODE_PUBLIC_ORIGIN: origin,
    KCODE_DATA_KEY: randomBytes(32).toString("base64"),
    KCODE_ALLOW_REGISTRATION: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => (logs += chunk.toString()));
child.stderr.on("data", (chunk) => (logs += chunk.toString()));

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await sleep(100);
  }
  throw new Error(`server did not start\n${logs}`);
}

async function request(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

function openSocket(url, protocols, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, options);
    const timer = setTimeout(
      () => reject(new Error("websocket open timeout")),
      5_000,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", listener);
      reject(new Error("websocket message timeout"));
    }, 5_000);
    const listener = (raw) => {
      const value = JSON.parse(raw.toString());
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
  });
}

let desktop;
let mobile;
try {
  await waitForServer();
  const candidates = [
    { username: "owner-a", password: "correct-horse-battery-a" },
    { username: "owner-b", password: "correct-horse-battery-b" },
  ];
  const registrations = await Promise.all(
    candidates.map(async (candidate) => {
      const response = await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...candidate, clientType: "desktop" }),
      });
      return { response, body: await response.json() };
    }),
  );
  assert.deepEqual(
    registrations.map(({ response }) => response.status).sort(),
    [201, 403],
  );
  const winnerIndex = registrations.findIndex(
    ({ response }) => response.status === 201,
  );
  const owner = candidates[winnerIndex];
  const token = registrations[winnerIndex].body.token;
  assert.ok(token);

  await request("/api/config", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      providers: [{ id: "openai", apiKey: "secret-api-key" }],
    }),
  });
  const config = await request("/api/config", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(config.body.config.providers[0].apiKey, "secret-api-key");

  const mobileLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: owner.username,
      password: owner.password,
      clientType: "mobile",
    }),
  });
  const cookie = mobileLogin.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const adminSession = await request("/api/admin/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(adminSession.body.user.username, owner.username);

  assert.equal((await request("/api/health")).body.registrationOpen, false);
  const openedRegistration = await request("/api/admin/settings", {
    method: "PUT",
    headers: { Cookie: cookie },
    body: JSON.stringify({ registrationOpen: true }),
  });
  assert.equal(openedRegistration.body.registrationOpen, true);
  const invalidRegistration = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "", password: "", clientType: "desktop" }),
  });
  assert.equal(invalidRegistration.status, 400);
  await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: "member",
      password: "correct-horse-battery-member",
      clientType: "desktop",
    }),
  });
  const closedRegistration = await request("/api/admin/settings", {
    method: "PUT",
    headers: { Cookie: cookie },
    body: JSON.stringify({ registrationOpen: false }),
  });
  assert.equal(closedRegistration.body.registrationOpen, false);
  const blockedRegistration = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "blocked-member",
      password: "correct-horse-battery-blocked",
      clientType: "desktop",
    }),
  });
  assert.equal(blockedRegistration.status, 403);

  const wsOrigin = origin.replace("http:", "ws:");
  const deviceId = "desktop-e2e";
  desktop = await openSocket(
    `${wsOrigin}/ws?deviceId=${deviceId}&name=Integration+PC&platform=win32&version=test`,
    ["kcode-v1", `kcode-token.${token}`],
  );
  mobile = await openSocket(`${wsOrigin}/ws`, [], {
    headers: { Cookie: cookie },
  });

  const tasksChanged = nextMessage(
    mobile,
    (message) => message.type === "tasks.changed",
  );
  desktop.send(
    JSON.stringify({
      type: "tasks.replace",
      tasks: [
        {
          id: "task-1",
          name: "Remote test",
          workspaceName: "kcode",
          createdAt: 1,
          updatedAt: 2,
          messages: [],
          activities: [],
        },
      ],
    }),
  );
  assert.equal((await tasksChanged).tasks[0].name, "Remote test");

  const streamed = nextMessage(
    mobile,
    (message) => message.type === "task.event" && message.event === "stream",
  );
  desktop.send(
    JSON.stringify({
      type: "task.event",
      event: "stream",
      taskId: "task-1",
      requestId: "request-1",
      content: "正在实时生成",
      progress: "正在检查项目",
      updatedAt: Date.now(),
    }),
  );
  const streamedMessage = await streamed;
  assert.equal(streamedMessage.deviceId, deviceId);
  assert.equal(streamedMessage.content, "正在实时生成");

  const desktopCommand = nextMessage(
    desktop,
    (message) => message.type === "command",
  );
  mobile.send(
    JSON.stringify({
      type: "command",
      id: "command-1",
      deviceId,
      command: {
        type: "task.send",
        taskId: "task-1",
        content: "继续",
        attachments: {
          images: [
            {
              id: "image-1",
              name: "screen.png",
              mediaType: "image/png",
              dataUrl: `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`,
              size: 11,
            },
          ],
          files: [
            {
              id: "file-1",
              name: "Component.vue",
              content: "<template><main /></template>",
              size: 29,
            },
          ],
        },
      },
    }),
  );
  const routed = await desktopCommand;
  assert.equal(routed.command.content, "继续");
  assert.equal(routed.command.attachments.images[0].size, 11);
  assert.equal(routed.command.attachments.files[0].name, "Component.vue");

  const commandResult = nextMessage(
    mobile,
    (message) => message.type === "command.result",
  );
  desktop.send(
    JSON.stringify({ type: "command.result", id: "command-1", ok: true }),
  );
  assert.equal((await commandResult).ok, true);

  const adminOverview = await request("/api/admin/overview", {
    headers: { Cookie: cookie },
  });
  assert.equal(adminOverview.body.totals.users, 2);
  assert.equal(adminOverview.body.totals.onlineDevices, 1);
  assert.equal(adminOverview.body.totals.tasks, 1);
  assert.equal(adminOverview.body.commands[0].commandType, "task.send");
  assert.equal(adminOverview.body.commands[0].status, "completed");

  desktop.close();
  mobile.close();
  await sleep(100);
  const rawDatabase = await readFile(database);
  assert.ok(!rawDatabase.includes(Buffer.from("secret-api-key")));
  assert.ok(!rawDatabase.includes(Buffer.from("Remote test")));
  assert.ok(!rawDatabase.includes(Buffer.from("继续")));
  console.log("KCode Remote integration check passed");
} finally {
  desktop?.terminate();
  mobile?.terminate();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2_000),
  ]);
  await rm(directory, { recursive: true, force: true });
}
