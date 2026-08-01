import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRemoteCommand,
  parseRemoteTaskEvent,
  parseTaskSnapshots,
  remoteCommandAuditPayload,
} from "./protocol.js";

test("accepts only the supported remote control commands", () => {
  assert.deepEqual(
    parseRemoteCommand({ type: "task.load", taskId: "task-1" }),
    { type: "task.load", taskId: "task-1" },
  );
  assert.deepEqual(
    parseRemoteCommand({
      type: "task.send",
      taskId: "task-1",
      content: "继续",
    }),
    { type: "task.send", taskId: "task-1", content: "继续" },
  );
  assert.throws(() =>
    parseRemoteCommand({ type: "run_command", taskId: "task-1" }),
  );
});

test("accepts bounded mobile attachments without retaining their bodies in audit data", () => {
  const imageData = Buffer.from("image-bytes").toString("base64");
  const command = parseRemoteCommand({
    type: "task.send",
    taskId: "task-1",
    content: "",
    attachments: {
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mediaType: "image/png",
          dataUrl: `data:image/png;base64,${imageData}`,
          size: 999,
        },
      ],
      files: [
        {
          id: "file-1",
          name: "Component.vue",
          content: "<template><main /></template>",
          size: 999,
        },
      ],
    },
  });
  assert.equal(command.type, "task.send");
  if (command.type !== "task.send") return;
  assert.equal(command.attachments?.images?.[0].size, 11);
  assert.equal(command.attachments?.files?.[0].size, 29);
  const audit = JSON.stringify(remoteCommandAuditPayload(command));
  assert.ok(!audit.includes(imageData));
  assert.ok(!audit.includes("<template>"));
  assert.ok(audit.includes("Component.vue"));
});

test("rejects empty sends and oversized attachment sets", () => {
  assert.throws(() =>
    parseRemoteCommand({ type: "task.send", taskId: "task-1", content: "" }),
  );
  assert.throws(() =>
    parseRemoteCommand({
      type: "task.send",
      taskId: "task-1",
      content: "附件",
      attachments: { files: Array.from({ length: 10 }, () => ({})) },
    }),
  );
});

test("validates bounded live stream replacement events", () => {
  assert.deepEqual(
    parseRemoteTaskEvent({
      type: "task.event",
      event: "stream",
      taskId: "task-1",
      requestId: "request-1",
      content: "实时输出\n",
      reasoning: "检查项目",
      progress: "正在读取文件",
      updatedAt: 100,
    }),
    {
      type: "task.event",
      event: "stream",
      taskId: "task-1",
      requestId: "request-1",
      content: "实时输出\n",
      reasoning: "检查项目",
      progress: "正在读取文件",
      updatedAt: 100,
    },
  );
  assert.throws(() =>
    parseRemoteTaskEvent({
      type: "task.event",
      event: "stream",
      taskId: "task-1",
      requestId: "request-1",
      content: "x".repeat(96_001),
      updatedAt: 100,
    }),
  );
});

test("bounds and validates task snapshots", () => {
  const task = {
    id: "task-1",
    name: "测试任务",
    workspaceName: "kcode",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    activities: [],
  };
  assert.deepEqual(parseTaskSnapshots([task]), [task]);
  assert.throws(() => parseTaskSnapshots([{ id: "bad" }]));
});
