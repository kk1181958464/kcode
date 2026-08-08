import assert from "node:assert/strict";
import test from "node:test";
import { remoteTaskSnapshot } from "../src/remote-snapshot";
import type { TaskRecord } from "../src/models";

test("builds a bounded remote task snapshot without absolute workspace paths", () => {
  const assistantContent =
    "<thinking>private chain of thought</thinking>已检查。远程可见结论";
  const finalResponseOffset = assistantContent.indexOf("远程可见结论");
  const task: TaskRecord = {
    id: "task-1",
    name: "远程任务",
    workspaceName: "保留的项目名",
    workspacePath: "D:\\projects\\private\\kcode",
    createdAt: 1,
    updatedAt: 2,
    modelSelection: "planner|sol",
    collaboration: {
      mode: "planner-executor",
      executorModelSelection: "executor|luna",
    },
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "继续",
        createdAt: 1,
        images: [
          {
            id: "image-1",
            name: "large.png",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,secret-binary-data",
            size: 100,
          },
        ],
        contextAttachments: [{ name: "Component.vue", size: 120 }],
      },
      {
        id: "message-2",
        role: "assistant",
        content: assistantContent,
        createdAt: 2,
        completedAt: 9,
        finalResponseOffset,
        finalResponseStartedAt: 8,
      },
    ],
    activities: [
      {
        id: "activity-1",
        requestId: "request-1",
        tool: "apply_patch",
        status: "success",
        title: "修改文件",
        liveStatus: "等待人工验证：请完成人机验证",
        input: { apiKey: "must-not-sync" },
        command: "deploy --token must-not-sync",
        path: "D:\\projects\\private\\kcode\\src\\App.tsx",
        startedAt: 1,
        textOffset: 6,
        subagentId: "agent-1",
      },
    ],
  };

  const snapshot = remoteTaskSnapshot(task);
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.workspaceName, "保留的项目名");
  assert.equal(snapshot.executorModelSelection, "executor|luna");
  assert.equal(snapshot.messages[0].imageCount, 1);
  assert.deepEqual(snapshot.messages[0].files, [
    { name: "Component.vue", size: 120 },
  ]);
  assert.equal(snapshot.messages[1].content, "已检查。远程可见结论");
  assert.equal(snapshot.messages[1].completedAt, 9);
  assert.equal(snapshot.messages[1].finalResponseOffset, "已检查。".length);
  assert.equal(snapshot.messages[1].finalResponseStartedAt, 8);
  assert.equal(snapshot.activities[0].path, "kcode/src/App.tsx");
  assert.equal(snapshot.activities[0].textOffset, 6);
  assert.equal(snapshot.activities[0].subagentId, "agent-1");
  assert.equal(
    snapshot.activities[0].liveStatus,
    "等待人工验证：请完成人机验证",
  );
  assert.ok(!serialized.includes("secret-binary-data"));
  assert.ok(!serialized.includes("must-not-sync"));
  assert.ok(!serialized.includes("D:\\\\projects"));
});
