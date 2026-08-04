import WebSocket from "ws";

const server = process.env.KCODE_DEMO_SERVER || "http://127.0.0.1:8787";
const username = process.env.KCODE_DEMO_USERNAME;
const password = process.env.KCODE_DEMO_PASSWORD;
const stress = process.env.KCODE_DEMO_STRESS === "1";
if (!username || !password)
  throw new Error("KCODE_DEMO_USERNAME and KCODE_DEMO_PASSWORD are required");

const login = await fetch(`${server}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password, clientType: "desktop" }),
});
const auth = await login.json();
if (!login.ok || !auth.token) throw new Error(auth.error || "login failed");

const wsUrl = new URL(server);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";
wsUrl.search = new URLSearchParams({
  deviceId: "demo-windows-pc",
  name: "工作电脑",
  platform: "win32",
  version: "demo",
}).toString();

const socket = new WebSocket(wsUrl, ["kcode-v1", `kcode-token.${auth.token}`]);
const now = Date.now();
const baseMessages = [
  {
    id: "user-1",
    role: "user",
    content: "检查手机版任务同步和远程审批流程。",
    createdAt: now - 180_000,
  },
  {
    id: "assistant-1",
    role: "assistant",
    content:
      "我已经完成账号连接和任务快照同步，现在正在验证手机端发送、停止和审批操作。",
    createdAt: now - 120_000,
    model: "gpt-5.6-sol",
  },
];
const stressMessages = stress
  ? Array.from({ length: 78 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? "assistant" : "user",
      content:
        index % 2
          ? `第 ${Math.floor(index / 2) + 1} 轮处理完成，已经核对界面状态、实时消息和滚动位置。`
          : `继续检查第 ${Math.floor(index / 2) + 1} 组移动端交互。`,
      createdAt: now - (80 - index) * 60_000,
      ...(index % 2 ? { model: "gpt-5.6-sol" } : {}),
    }))
  : [];
const primaryTask = {
  id: "demo-task",
  name: "优化 KCode 远程控制",
  workspaceName: "kcode",
  createdAt: now - 3_600_000,
  updatedAt: now,
  runStatus: "running",
  runningId: "demo-run",
  modelSelection: "openai|gpt-5.6-sol",
  messages: [...stressMessages, ...baseMessages],
  activities: [
    {
      id: "activity-1",
      requestId: "demo-run",
      tool: "apply_patch",
      status: "completed",
      title: "接入远程任务快照",
      narrative: "让手机断线重连后仍能恢复任务详情。",
      startedAt: now - 90_000,
      completedAt: now - 70_000,
      path: "src/remote-snapshot.ts",
      additions: 86,
      deletions: 0,
    },
    {
      id: "activity-2",
      requestId: "demo-run",
      tool: "run_command",
      status: "running",
      title: "验证移动端连接",
      narrative: "检查手机消息是否能准确路由到当前电脑。",
      startedAt: now - 35_000,
    },
  ],
  usage: { input: 18240, output: 1368, cached: 9200 },
  durationMs: 155000,
};
const tasks = [
  primaryTask,
  ...(stress
    ? Array.from({ length: 78 }, (_, index) => ({
        id: `demo-task-${index + 2}`,
        name: `移动端验收任务 ${index + 2}`,
        workspaceName: index % 2 ? "kcode" : "remote-service",
        createdAt: now - (index + 3) * 3_600_000,
        updatedAt: now - (index + 2) * 120_000,
        runStatus: index % 5 === 0 ? "failed" : "completed",
        modelSelection: "openai|gpt-5.6-sol",
        messages: [
          {
            id: `demo-task-${index + 2}-message`,
            role: "assistant",
            content: `任务 ${index + 2} 已完成移动端同步检查。`,
            createdAt: now - (index + 2) * 120_000,
            model: "gpt-5.6-sol",
          },
        ],
        activities: [],
      }))
    : []),
];

function publish() {
  socket.send(JSON.stringify({ type: "tasks.replace", tasks }));
}

const liveOutput = [
  "正在核对手机端实时输出链路。",
  "服务器已经保存最新的正文增量。",
  "手机切到后台再回来时会恢复已生成内容。",
  "任务结束后，最终回答会替换实时缓存。",
];
let liveOutputTimer;
socket.on("open", () => {
  publish();
  let index = 0;
  liveOutputTimer = setInterval(() => {
    index = Math.min(index + 1, liveOutput.length);
    socket.send(
      JSON.stringify({
        type: "task.event",
        event: "stream",
        taskId: tasks[0].id,
        requestId: tasks[0].runningId,
        content: liveOutput.slice(0, index).join("\n"),
        progress: "正在同步实时正文",
        updatedAt: Date.now(),
      }),
    );
    if (index === liveOutput.length) clearInterval(liveOutputTimer);
  }, 450);
});
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type !== "command") return;
  const command = message.command;
  if (command.type === "task.send") {
    tasks[0].messages.push({
      id: command.clientMessageId || `remote-${Date.now()}`,
      role: "user",
      content: command.content,
      createdAt: Date.now(),
    });
    tasks[0].updatedAt = Date.now();
    publish();
  }
  socket.send(
    JSON.stringify({ type: "command.result", id: message.id, ok: true }),
  );
});

function close() {
  if (liveOutputTimer) clearInterval(liveOutputTimer);
  socket.close();
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
