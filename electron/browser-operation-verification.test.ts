import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedBrowserOperations,
  missingRequestedBrowserOperations,
  reportsMissingBrowserTarget,
  requestedBrowserOperations,
  successfulBrowserEvidence,
} from "./browser-operation-verification";

test("requires tool evidence for browser actions claimed in final text", () => {
  assert.deepEqual([...claimedBrowserOperations("已打开登录页面。")], ["open"]);
  const claimed = claimedBrowserOperations(
    "已打开登录页面，输入账号密码并点击提交，最后确认页面显示正常。",
  );
  assert.deepEqual([...claimed], ["open", "type", "click", "verify"]);
  assert.deepEqual(
    missingRequestedBrowserOperations(claimed, new Set(["open"])),
    ["type", "click", "verify"],
  );
  assert.deepEqual(
    [
      ...claimedBrowserOperations(
        "尚未打开页面，也没有输入账号、点击按钮或验证结果。",
      ),
    ],
    [],
  );
  assert.deepEqual(
    [...claimedBrowserOperations("如果已经点击提交，就检查页面结果。")],
    [],
  );
});

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
    "我的页面，右上角门店标签改为切换门店，点击后弹窗，输入账号密码，直接登录另一个账号",
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

  for (const implementationSummary of [
    "已实现登录弹窗，输入账号密码并点击提交后切换账号。",
    "已修改页面，支持点击按钮、输入账号密码并提交。",
    "已经完成门店切换功能，点击后弹窗并输入账号密码。",
  ])
    assert.deepEqual([...claimedBrowserOperations(implementationSummary)], []);

  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content: "把项目提交后的已提交数量和列表修好",
        },
        { kind: "message", role: "assistant", content: "已经修改。" },
        {
          kind: "message",
          role: "user",
          content: "还是不对，提交了一个项目，上面已提交显示还是0，列表也没有",
        },
      ]),
    ],
    [],
  );
});

test("treats a user's own login self-report and UI bug reports as non-browser", () => {
  // The exact real-world false positive: user describes logging in themselves
  // and reports a missing button — a mini-program dev bug, not browser work.
  assert.deepEqual(
    [
      ...requestedBrowserOperations([
        {
          kind: "message",
          role: "user",
          content:
            "我现在在用 新田乡 xtx123456 这个账号密码登录上去 没有出来添加按钮啊",
        },
      ]),
    ],
    [],
  );
  // Self-report with a completion marker, no agent-directed request phrasing.
  for (const content of [
    "我已经登录上去了，页面没显示新按钮",
    "我现在用测试账号登录进去了，列表不刷新",
    "我点击了提交，但页面没反应",
  ])
    assert.deepEqual(
      [
        ...requestedBrowserOperations([
          { kind: "message", role: "user", content },
        ]),
      ],
      [],
    );
  // A genuine agent-directed request must still be detected.
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
});

test("recognizes a stale missing-URL reply while a browser session can be reused", () => {
  assert.equal(
    reportsMissingBrowserTarget(
      "当前消息没有提供可操作的网页地址或点击目标，因此无法继续。",
    ),
    true,
  );
  assert.equal(
    reportsMissingBrowserTarget("页面已打开，但还需要用户提供短信验证码。"),
    false,
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
