import assert from "node:assert/strict";
import test from "node:test";
import {
  claimedUnavailableGitOperations,
  claimedGitOperations,
  missingRequestedGitOperations,
  requestedGitOperations,
  successfulGitEvidence,
  unavailableGitOperations,
} from "./git-operation-verification";

test("detects requested and claimed Git release operations", () => {
  assert.deepEqual(
    [
      ...requestedGitOperations([
        {
          kind: "message",
          role: "user",
          content: "提交到 GitHub 并触发打包",
        },
      ]),
    ],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [...claimedGitOperations("已提交并推送，Release 工作流已触发")],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [...claimedGitOperations("我提交了修改、推送了分支并触发了打包工作流")],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [...claimedGitOperations("尚未提交，无法推送，也没有成功触发发布工作流。")],
    [],
  );
  assert.deepEqual(
    [...claimedGitOperations("如果推送了分支，就会触发发布工作流。")],
    [],
  );
  assert.deepEqual(
    missingRequestedGitOperations(
      claimedGitOperations("我提交了修改并推送了分支"),
      new Set(["commit"]),
    ),
    ["push"],
  );
});

test("does not mistake planned/future Git work for a completed claim", () => {
  // The real-world false positive: the model describes a PLAN (create repos,
  // then commit) and it must NOT be read as an already-completed commit that
  // demands tool evidence — otherwise the turn is wrongly paused.
  for (const planning of [
    "代码已准备好，稍后提交到两个私有仓库",
    "接下来我会提交并推送到 GitHub",
    "计划提交前端代码，然后推送到远端",
    "准备触发打包工作流",
    "下一步提交 PHP 代码并创建 Release",
  ])
    assert.deepEqual([...claimedGitOperations(planning)], [], planning);
  // Genuine completed claims are still detected after the change.
  assert.deepEqual(
    [...claimedGitOperations("已成功提交并推送，Release 工作流已触发")],
    ["commit", "push", "release"],
  );
  assert.deepEqual([...claimedGitOperations("我已经提交了修改")], ["commit"]);
  // A description of the plan is not a request for the agent to run Git either.
  assert.deepEqual(
    requestedGitOperations([
      {
        kind: "message",
        role: "user",
        content: "这样吧 php一个仓库 前端一个仓库 都设置私有",
      },
    ]),
    new Set(),
  );
});

test("does not mistake application submission language for Git work", () => {
  const nonGitRequests = [
    'index/order/send {"code":2,"msg":"提交微信发货信息失败，请重新发货，错误原因：支付单不存在"} 我去找哪个字段看',
    "帮我排查订单提交失败和消息推送异常",
    "查看发布消息接口的参数，并运行本地打包检查",
    "为什么默认就走 Git 提交了？我没让它处理 Git",
  ];
  for (const content of nonGitRequests) {
    assert.deepEqual(
      requestedGitOperations([{ kind: "message", role: "user", content }]),
      new Set(),
      content,
    );
  }
});

test("does not mistake business submission state for a completed commit", () => {
  for (const businessSummary of [
    "因为这条记录已经超过提交有效时间，不能继续使用原记录生成。",
    "已提交数据库查询并确认返回结果为空。",
    "订单已提交，消息已推送到队列。",
    "任务超过提交窗口后已退款，没有重复提交。",
    "版本已提交审核，等待业务人员确认。",
  ])
    assert.deepEqual(
      [...claimedGitOperations(businessSummary)],
      [],
      businessSummary,
    );
});

test("keeps explicit code and repository Git requests actionable", () => {
  const cases: Array<[string, string[]]> = [
    ["提交代码", ["commit"]],
    ["把这些改动提交并推送到远端", ["commit", "push"]],
    ["运行 git commit 后再 git push", ["commit", "push"]],
    ["触发 GitHub Actions 打包工作流", ["release"]],
  ];
  for (const [content, expected] of cases) {
    assert.deepEqual(
      [...requestedGitOperations([{ kind: "message", role: "user", content }])],
      expected,
      content,
    );
  }
});

test("does not inherit a business submission as Git work on continue", () => {
  assert.deepEqual(
    requestedGitOperations([
      {
        kind: "message",
        role: "user",
        content: "排查提交微信发货信息失败的问题",
      },
      {
        kind: "message",
        role: "assistant",
        content: "接下来继续检查提交支付单号时使用的字段。",
      },
      { kind: "message", role: "user", content: "继续" },
    ]),
    new Set(),
  );
});

test("requires successful tool results as Git evidence", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "commit",
        name: "run_command",
        input: { command: "git commit -m test" },
      },
      {
        id: "push",
        name: "run_command",
        input: { command: "git push origin main" },
      },
      {
        id: "release",
        name: "run_command",
        input: { command: "gh run view 123" },
      },
    ],
  };
  const evidence = successfulGitEvidence([
    calls,
    { kind: "result", callId: "commit", content: '{"success":true}' },
    { kind: "result", callId: "push", content: '{"success":false}' },
    { kind: "result", callId: "release", content: '{"success":true}' },
  ]);
  assert.deepEqual([...evidence], ["commit"]);
  assert.deepEqual(
    [
      ...successfulGitEvidence([
        calls,
        { kind: "result", callId: "commit", content: '{"success":true}' },
        { kind: "result", callId: "push", content: '{"success":true}' },
        { kind: "result", callId: "release", content: '{"success":true}' },
      ]),
    ],
    ["commit", "push", "release"],
  );
});

test("accepts successful Git operations executed through SSH", () => {
  const calls = {
    kind: "calls" as const,
    calls: [
      {
        id: "remote-commit",
        name: "ssh_run",
        input: { command: "git commit -m release" },
      },
      {
        id: "remote-push",
        name: "ssh_run",
        input: { command: "git push origin main" },
      },
      {
        id: "remote-trigger",
        name: "ssh_run",
        input: { command: "gh workflow run package.yml" },
      },
      {
        id: "remote-verify",
        name: "ssh_run",
        input: { command: "gh run view 123" },
      },
    ],
  };
  assert.deepEqual(
    [
      ...successfulGitEvidence([
        calls,
        {
          kind: "result",
          callId: "remote-commit",
          content: '{"success":true}',
        },
        {
          kind: "result",
          callId: "remote-push",
          content: '{"success":true}',
        },
        {
          kind: "result",
          callId: "remote-trigger",
          content: '{"success":true}',
        },
        {
          kind: "result",
          callId: "remote-verify",
          content: '{"success":true}',
        },
      ]),
    ],
    ["commit", "push", "release"],
  );
});

test("treats a verified non-repository as an explicit Git blocker", () => {
  const history = [
    {
      kind: "calls" as const,
      calls: [
        {
          id: "probe",
          name: "ssh_run",
          input: { command: "git status --short --branch" },
        },
      ],
    },
    {
      kind: "result" as const,
      callId: "probe",
      content: JSON.stringify({
        success: false,
        data: { output: "fatal: not a git repository (or any parent)" },
      }),
    },
  ];
  assert.deepEqual(
    [...unavailableGitOperations(history)],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [
      ...claimedUnavailableGitOperations(
        "线上目录不是 Git 仓库，因此无法提交和推送，也不能确定发布目标。",
      ),
    ],
    ["commit", "push", "release"],
  );
});

test("model text and legacy results never count as execution evidence", () => {
  assert.deepEqual(
    [
      ...successfulGitEvidence([
        {
          kind: "message",
          role: "assistant",
          content: "已提交 571a852 并触发打包",
        },
        {
          kind: "calls",
          calls: [
            {
              id: "push",
              name: "run_command",
              input: { command: "git push" },
            },
          ],
        },
        { kind: "result", callId: "push", content: "命令执行成功" },
      ]),
    ],
    [],
  );
});

test("inherits an actionable Git request but ignores status questions", () => {
  assert.deepEqual(
    [
      ...requestedGitOperations([
        {
          kind: "message",
          role: "user",
          content: "提交到 GitHub 并触发打包",
        },
        { kind: "message", role: "assistant", content: "正在推送。" },
        {
          kind: "message",
          role: "user",
          content:
            "<interrupted_turn_recovery>核对修改并验证后继续。</interrupted_turn_recovery>",
        },
      ]),
    ],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [
      ...requestedGitOperations([
        {
          kind: "message",
          role: "user",
          content: "提交到 GitHub 并触发打包",
        },
        { kind: "message", role: "assistant", content: "可以开始。" },
        { kind: "message", role: "user", content: "开始吧" },
      ]),
    ],
    ["commit", "push", "release"],
  );
  assert.deepEqual(
    [
      ...requestedGitOperations([
        { kind: "message", role: "user", content: "已经提交到 GitHub 了吗？" },
      ]),
    ],
    [],
  );
  assert.deepEqual(
    missingRequestedGitOperations(
      new Set(["commit", "push", "release"]),
      new Set(["commit"]),
    ),
    ["push", "release"],
  );
});
