import assert from "node:assert/strict";
import test from "node:test";
import { remoteTaskSnapshot } from "../src/remote-snapshot";
import type { TaskRecord } from "../src/models";

test("builds a bounded remote task snapshot without absolute workspace paths", () => {
  const task: TaskRecord = {
    id: "task-1",
    name: "远程任务",
    workspacePath: "D:\\projects\\private\\kcode",
    createdAt: 1,
    updatedAt: 2,
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
      },
      {
        id: "message-2",
        role: "assistant",
        content: "<thinking>private chain of thought</thinking>远程可见结论",
        createdAt: 2,
      },
    ],
    activities: [
      {
        id: "activity-1",
        requestId: "request-1",
        tool: "apply_patch",
        status: "success",
        title: "修改文件",
        input: { apiKey: "must-not-sync" },
        command: "deploy --token must-not-sync",
        path: "D:\\projects\\private\\kcode\\src\\App.tsx",
        startedAt: 1,
      },
    ],
  };

  const snapshot = remoteTaskSnapshot(task);
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.workspaceName, "kcode");
  assert.equal(snapshot.messages[0].imageCount, 1);
  assert.equal(snapshot.messages[1].content, "远程可见结论");
  assert.equal(snapshot.activities[0].path, "kcode/src/App.tsx");
  assert.ok(!serialized.includes("secret-binary-data"));
  assert.ok(!serialized.includes("must-not-sync"));
  assert.ok(!serialized.includes("D:\\\\projects"));
});
