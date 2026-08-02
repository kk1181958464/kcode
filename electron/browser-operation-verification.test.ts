import assert from "node:assert/strict";
import test from "node:test";
import {
  missingRequestedBrowserOperations,
  requestedBrowserOperations,
  successfulBrowserEvidence,
} from "./browser-operation-verification";

test("detects requested browser actions and ignores capability questions", () => {
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content: "帮我登录 Gmail，填写账号密码并点击下一步",
        },
      ]),
    ],
    ["open", "type", "click", "verify"],
  );
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content: "这个应用能不能打开网页？",
        },
      ]),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content: "打开 Gmail 登录页面",
        },
      ]),
    ],
    ["open"],
  );
});

test("does not confuse Git commits or UI bug descriptions with browser actions", () => {
  for (const content of [
    "提交改动并推送 main，再打新版本标签触发打包",
    "修复页面滚动卡顿和点击左侧节点的问题",
    "选择模型后修改代码并提交到 GitHub",
  ])
    assert.deepEqual(
      [
        ...requestedBrowserOperations([
          { kind: "message", role: "user", content },
        ]),
      ],
      [],
    );

  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content: "提交网页表单并查看页面",
        },
      ]),
    ],
    ["click", "verify"],
  );
});

test("continuation replies inherit the previous browser action", () => {
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        { kind: "message", role: "user", content: "点击下一步并查看页面" },
        { kind: "message", role: "assistant", content: "正在操作。" },
        {
          kind: "message",
          role: "user",
          content:
            "<interrupted_turn_recovery>核对修改并验证后继续。</interrupted_turn_recovery>",
        },
      ]),
    ],
    ["click", "verify"],
  );
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        { kind: "message", role: "user", content: "点击下一步并查看页面" },
        { kind: "message", role: "assistant", content: "准备执行。" },
        { kind: "message", role: "user", content: "继续" },
      ]),
    ],
    ["click", "verify"],
  );
});

test("requires a fresh snapshot after browser interaction", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      { id: "open", name: "browser_open", input: {} },
      { id: "before", name: "browser_snapshot", input: {} },
      { id: "type", name: "browser_type", input: {} },
      { id: "click", name: "browser_click", input: {} },
      { id: "after", name: "browser_snapshot", input: {} },
    ],
  };
  const success = (callId: string) => ({
    kind: "result" as const,
    callId,
    content: '{"success":true}',
  });
  assert.deepEqual(
    [
      ...successfulBrowserEvidence([
        calls,
        success("open"),
        success("before"),
        success("type"),
        success("click"),
      ]),
    ],
    ["open", "type", "click"],
  );
  const evidence = successfulBrowserEvidence([
    calls,
    success("open"),
    success("before"),
    success("type"),
    success("click"),
    success("after"),
  ]);
  assert.deepEqual([...evidence], ["open", "type", "click", "verify"]);
  assert.deepEqual(
    missingRequestedBrowserOperations(
      new Set(["open", "type", "click", "verify"]),
      evidence,
    ),
    [],
  );
});

test("carries browser evidence from a completed subagent", () => {
  const evidence = successfulBrowserEvidence([
    {
      kind: "calls",
      calls: [{ id: "child", name: "wait_agent", input: {} }],
    },
    {
      kind: "result",
      callId: "child",
      content:
        '{"success":true,"data":{"browserOperationEvidence":["click","verify"]}}',
    },
  ]);
  assert.deepEqual([...evidence], ["click", "verify"]);
});
