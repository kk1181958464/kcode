import assert from "node:assert/strict";
import test from "node:test";
import type { AgentActivity, ModelRequest } from "../src/types";
import type { AgentRunner } from "./agent-types";
import {
  executeControlTool,
  type CommandToolDeps,
  type ControlToolContext,
} from "./agent-control-tools";
import {
  executeSubagentTool,
  subagentWaitTimeoutMs,
  type SubagentToolDeps,
} from "./subagent-tools";
import type {
  SubagentExecutionTarget,
  SubagentRunner,
  WaitForSubagentsOptions,
} from "./subagents";

const signal = () => new AbortController().signal;
const runChild: AgentRunner = async function* () {};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    providerId: "planner-provider",
    modelId: "gpt-planner",
    messages: [{ role: "user", content: "修一下登录页的报错提示" }],
    permissionMode: "full-access",
    workspacePath: "/ws",
    ...overrides,
  };
}

function ctx(
  name: string,
  input: Record<string, unknown> = {},
  overrides: Partial<ControlToolContext> = {},
): ControlToolContext {
  return {
    root: "/ws",
    requestId: "req-1",
    name,
    input,
    request: request(),
    signal: signal(),
    runChildAgent: runChild,
    onProgress: () => undefined,
    ...overrides,
  };
}

function activity(
  partial: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id: "act-1",
    requestId: "subagent:1",
    tool: "write_file",
    status: "success",
    title: "写入",
    startedAt: 1,
    completedAt: 2,
    input: { path: "a.ts" },
    path: "a.ts",
    additions: 2,
    deletions: 1,
    changed: true,
    ...partial,
  };
}

function memorySubagent(
  overrides: Partial<SubagentToolDeps> = {},
): SubagentToolDeps & {
  calls: string[];
  spawned: Array<{
    name: string;
    task: string;
    runner: SubagentRunner;
    target?: SubagentExecutionTarget;
  }>;
  waitOptions?: WaitForSubagentsOptions;
} {
  const calls: string[] = [];
  const spawned: Array<{
    name: string;
    task: string;
    runner: SubagentRunner;
    target?: SubagentExecutionTarget;
  }> = [];
  const listed = [{ id: "child-1", name: "代码", status: "running" }];
  return {
    calls,
    spawned,
    maxDepth: 1,
    waitMinMs: 5_000,
    waitSliceMs: 60_000,
    executorModelOverrides: () => undefined,
    async getProviderWithKey(id) {
      calls.push(`provider:${id}`);
      return {
        enabled: true,
        models: [{ modelId: "gpt-executor" }],
      };
    },
    latestUserRequestContent: () => "修一下登录页的报错提示",
    collectedSubagentSummaries: () => [],
    permissionPolicyForSubagent: (_mode, policy) => policy,
    spawnSubagent(_parent, name, task, _signal, runner, target) {
      calls.push(`spawn:${name}`);
      spawned.push({ name, task, runner, target });
      return { id: "child-1", name, task, status: "running" };
    },
    listSubagents(parentRequestId) {
      calls.push(`list:${parentRequestId}`);
      return listed as ReturnType<SubagentToolDeps["listSubagents"]>;
    },
    messageSubagent(parentRequestId, agentId, message) {
      calls.push(`message:${parentRequestId}:${agentId}:${message}`);
      return { id: agentId, status: "running", message };
    },
    async waitForSubagents(parentRequestId, agentIds, options) {
      calls.push(
        `wait:${parentRequestId}:${(agentIds ?? []).join(",")}:${options.timeoutMs}`,
      );
      this.waitOptions = options;
      const child = activity();
      return {
        message: "已有 1 个子 Agent 返回结果。",
        timedOut: false,
        interrupted: false,
        progressed: true,
        completed: [
          {
            id: "child-1",
            name: "代码",
            task: "检查代码",
            status: "completed" as const,
            startedAt: 1,
            completedAt: 2,
            usage: { input: 10, output: 4, cached: 2 },
            collected: true,
            transcript: "done",
            instructions: [],
            activities: [],
            activityRecords: [child],
            usageDelta: { input: 10, output: 4, cached: 2 },
          },
        ],
        pending: [],
      };
    },
    async stopSubagent(parentRequestId, agentId) {
      calls.push(`stop:${parentRequestId}:${agentId}`);
      const child = activity({ id: "act-stop" });
      return {
        id: agentId,
        name: "代码",
        task: "检查代码",
        status: "stopped" as const,
        startedAt: 1,
        completedAt: 3,
        usage: { input: 3, output: 1, cached: 0 },
        collected: true,
        transcript: "partial",
        instructions: [],
        activities: [],
        activityRecords: [child],
        usageDelta: { input: 3, output: 1, cached: 0 },
      };
    },
    subscribeToSteering(requestId, listener) {
      calls.push(`steer:${requestId}`);
      listener();
      return () => undefined;
    },
    ...overrides,
  };
}

function memoryCommand(
  overrides: Partial<CommandToolDeps> = {},
): CommandToolDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    platform: "linux",
    async listMcpTools(server) {
      calls.push(`mcp-list:${server}`);
      return [{ name: "search", description: "find docs" }];
    },
    async callMcpTool(server, tool, args) {
      calls.push(`mcp-call:${server}:${tool}:${JSON.stringify(args)}`);
      return { output: "ok", isError: false };
    },
    async resolveProjectDiagnostic(_root, kind) {
      calls.push(`diag:${kind}`);
      if (kind === "lint")
        return { available: ["build"], message: "项目未配置 lint 脚本，已跳过。" };
      return {
        script: "typecheck",
        command: "npm run typecheck",
        available: ["typecheck"],
      };
    },
    async command(root, executable, args, _signal, timeoutMs) {
      calls.push(
        `command:${root}:${executable}:${args.join(" ")}:${timeoutMs}`,
      );
      return { output: "passed", exitCode: 0 };
    },
    ...overrides,
  };
}

test("subagentWaitTimeoutMs clamps requested and override windows", () => {
  assert.equal(subagentWaitTimeoutMs(1_000, undefined, 5_000, 60_000), 5_000);
  assert.equal(subagentWaitTimeoutMs(120_000, undefined, 5_000, 60_000), 60_000);
  assert.equal(subagentWaitTimeoutMs("nope", undefined, 5_000, 60_000), 60_000);
  assert.equal(subagentWaitTimeoutMs(5_000, 100, 5_000, 60_000), 100);
  assert.equal(subagentWaitTimeoutMs(5_000, 70_000, 5_000, 60_000), 5_000);
});

test("spawn_agent records a regular child and forwards the runner", async () => {
  const deps = memorySubagent();
  const result = await executeSubagentTool(
    ctx("spawn_agent", { task: "检查登录页", name: "代码" }),
    deps,
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.id, "child-1");
  assert.equal(parsed.name, "代码");
  assert.equal(deps.spawned[0]?.task, "检查登录页");
  assert.equal(deps.spawned[0]?.target, undefined);
  const events = deps.spawned[0]!.runner("subagent:1", "child-1", signal());
  const { value } = await events.next();
  assert.equal(value, undefined);
});

test("spawn_agent threads executor model, user goal and prior summary", async () => {
  const childRequests: ModelRequest[] = [];
  const childRun: AgentRunner = async function* (_id, req) {
    childRequests.push(req);
  };
  const deps = memorySubagent({
    executorModelOverrides: () => ({
      providerId: "executor-provider",
      modelId: "gpt-executor",
      displayName: "GPT Executor",
      reasoningEffort: "high",
      contextWindow: 32_000,
      agentRole: "executor",
      collaboration: undefined,
    }),
    collectedSubagentSummaries: () => [
      {
        name: "上一轮",
        status: "completed",
        transcript: "已改完 foo.ts",
      },
    ],
  });
  const result = await executeSubagentTool(
    ctx(
      "spawn_agent",
      { task: "落实计划", role: "executor" },
      {
        runChildAgent: childRun,
        request: request({
          agentRole: "planner",
          taskId: "task-9",
          messages: [
            {
              role: "user",
              content: "修一下登录页的报错提示",
              images: [
                {
                  id: "img-1",
                  name: "shot.png",
                  mediaType: "image/png",
                  dataUrl: "data:image/png;base64,abc",
                  size: 3,
                },
              ],
            },
          ],
        }),
      },
    ),
    deps,
  );
  assert.equal(JSON.parse(result.output).name, "执行 Agent");
  assert.equal(deps.calls.includes("provider:executor-provider"), true);
  assert.deepEqual(deps.spawned[0]?.target, {
    agentRole: "executor",
    providerId: "executor-provider",
    modelId: "gpt-executor",
    modelDisplayName: "GPT Executor",
    reasoningEffort: "high",
  });
  await deps.spawned[0]!.runner("subagent:1", "child-1", signal()).next();
  assert.equal(childRequests[0]?.agentDepth, 1);
  assert.equal(childRequests[0]?.modelId, "gpt-executor");
  assert.equal(childRequests[0]?.taskId, "task-9:subagent:child-1");
  assert.match(childRequests[0]?.messages[0]?.content ?? "", /原始用户目标/);
  assert.match(childRequests[0]?.messages[0]?.content ?? "", /上一执行 Agent（上一轮）/);
  assert.deepEqual(childRequests[0]?.messages[0]?.images, [
    {
      id: "img-1",
      name: "shot.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,abc",
      size: 3,
    },
  ]);
});

test("spawn_agent rejects depth, empty task, unknown role and disabled executor", async () => {
  const deps = memorySubagent();
  await assert.rejects(
    () =>
      executeSubagentTool(
        ctx("spawn_agent", { task: "再下一层" }, { request: request({ agentDepth: 1 }) }),
        deps,
      ),
    /已达到委派深度/,
  );
  await assert.rejects(
    () => executeSubagentTool(ctx("spawn_agent", { task: "   " }), deps),
    /缺少子 Agent 任务目标/,
  );
  await assert.rejects(
    () =>
      executeSubagentTool(
        ctx("spawn_agent", { task: "x", role: "planner" }),
        deps,
      ),
    /不支持的子 Agent 角色/,
  );
  const disabled = memorySubagent({
    executorModelOverrides: () => ({
      providerId: "executor-provider",
      modelId: "gpt-executor",
      displayName: "GPT Executor",
      reasoningEffort: "auto",
      agentRole: "executor",
      collaboration: undefined,
    }),
    async getProviderWithKey() {
      return { enabled: false, models: [{ modelId: "gpt-executor" }] };
    },
  });
  await assert.rejects(
    () =>
      executeSubagentTool(
        ctx("spawn_agent", { task: "落实计划", role: "executor" }),
        disabled,
      ),
    /执行模型供应商已停用/,
  );
});

test("list_agents and message_agent serialize injected registry results", async () => {
  const deps = memorySubagent();
  const listed = await executeSubagentTool(ctx("list_agents"), deps);
  assert.equal(JSON.parse(listed.output)[0].id, "child-1");
  const messaged = await executeSubagentTool(
    ctx("message_agent", { agentId: "child-1", message: "继续验证" }),
    deps,
  );
  assert.equal(JSON.parse(messaged.output).id, "child-1");
  assert.equal(deps.calls.includes("message:req-1:child-1:继续验证"), true);
});

test("wait_agent aggregates child activities, usage and wait counters", async () => {
  const deps = memorySubagent();
  const result = await executeSubagentTool(
    ctx("wait_agent", { agentIds: ["child-1"], timeoutMs: 1_000 }, { waitTimeoutOverrideMs: 2_000 }),
    deps,
  );
  assert.equal(deps.calls.includes("wait:req-1:child-1:2000"), true);
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.changed, true);
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 1);
  assert.deepEqual(result.subagentUsage, { input: 10, output: 4, cached: 2 });
  assert.deepEqual(result.subagentWait, {
    completed: 1,
    pending: 0,
    timedOut: false,
    interrupted: false,
    progressed: true,
  });
  assert.equal(result.childActivities?.[0]?.path, "a.ts");
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.completed[0].activityRecords, undefined);
  assert.equal(parsed.completed[0].usageDelta, undefined);
  assert.equal(parsed.completed[0].id, "child-1");
});

test("stop_agent returns partial child activities without leaking records in JSON", async () => {
  const deps = memorySubagent();
  const result = await executeSubagentTool(
    ctx("stop_agent", { agentId: "child-1" }),
    deps,
  );
  assert.equal(result.childActivities?.[0]?.id, "act-stop");
  assert.deepEqual(result.subagentUsage, { input: 3, output: 1, cached: 0 });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.activityRecords, undefined);
  assert.equal(parsed.usageDelta, undefined);
  assert.equal(parsed.status, "stopped");
});

test("update_plan, report_no_change and request_user_input stay local", async () => {
  const plan = await executeControlTool(
    ctx("update_plan", {
      explanation: "先查再改",
      plan: [
        { step: "检查登录页", status: "in_progress", requires: ["inspect"] },
        { step: "修复提示", status: "pending", requires: ["modify"] },
      ],
    }),
  );
  assert.equal(plan.output, "计划已更新：先查再改");
  assert.equal(plan.planUpdate?.plan[0]?.status, "in_progress");

  const noChange = await executeControlTool(
    ctx("report_no_change", { reason: "对照源码后确认无需修改" }),
  );
  assert.equal(noChange.noChangeReported, true);
  assert.equal(noChange.changed, false);

  await assert.rejects(
    () => executeControlTool(ctx("report_no_change", { reason: "太短" })),
    /必须包含具体检查结论/,
  );

  const pending = await executeControlTool(
    ctx("request_user_input", {
      question: "需要目标环境的登录账号",
      fields: ["username", "password"],
    }),
  );
  assert.equal(pending.userInputRequested, true);
  assert.match(pending.output, /username、password/);
});

test("mcp tools use injected clients and never spawn a server", async () => {
  const command = memoryCommand();
  const listed = await executeControlTool(
    ctx("mcp_list_tools", { server: "docs" }),
    { command },
  );
  const parsed = JSON.parse(listed.output);
  assert.equal(parsed.server, "docs");
  assert.equal(parsed.tools[0].name, "search");
  assert.equal(listed.executed, true);

  const called = await executeControlTool(
    ctx("mcp_call_tool", {
      server: "docs",
      tool: "search",
      arguments: { q: "agent" },
    }),
    { command },
  );
  assert.equal(called.output, "ok");
  assert.deepEqual(called.operationEvidence, ["execute"]);
  assert.equal(command.calls.includes('mcp-call:docs:search:{"q":"agent"}'), true);

  const errored = await executeControlTool(
    ctx("mcp_call_tool", { server: "docs", tool: "search" }),
    {
      command: memoryCommand({
        async callMcpTool() {
          return { output: "boom", isError: true };
        },
      }),
    },
  );
  assert.match(errored.output, /MCP 工具返回错误：boom/);
  assert.deepEqual(errored.operationEvidence, []);
});

test("diagnostics skips missing scripts and runs configured ones through injected command", async () => {
  const command = memoryCommand();
  const skipped = await executeControlTool(ctx("diagnostics", { kind: "lint" }), {
    command,
  });
  assert.equal(skipped.executed, false);
  assert.equal(skipped.command, "未执行");
  assert.match(skipped.output ?? "", /未配置 lint 脚本/);

  const ran = await executeControlTool(ctx("diagnostics", { kind: "typecheck" }), {
    command,
  });
  assert.equal(ran.executed, true);
  assert.equal(ran.command, "npm run typecheck");
  assert.equal(ran.exitCode, 0);
  assert.deepEqual(ran.operationEvidence, ["execute", "validate"]);
  assert.match(command.calls.join("\n"), /\/bin\/sh:-lc npm run typecheck/);
});

test("local command fallback classifies inspect, validate and modify evidence", async () => {
  const command = memoryCommand();
  const inspect = await executeControlTool(
    ctx("run_command", { command: "ls", purpose: "inspect" }),
    { command },
  );
  assert.deepEqual(inspect.operationEvidence, ["execute", "inspect"]);
  assert.equal(inspect.mutationAttempted, false);

  const validate = await executeControlTool(
    ctx("run_command", { command: "npm test", purpose: "validate" }),
    { command },
  );
  assert.deepEqual(validate.operationEvidence, ["execute", "validate"]);

  const modify = await executeControlTool(
    ctx("run_command", { command: "node write.js", purpose: "modify" }),
    { command },
  );
  assert.equal(modify.mutationAttempted, true);
  assert.deepEqual(modify.operationEvidence, ["execute", "modify"]);
});

test("windows command shapes are rejected without spawning", async () => {
  const command = memoryCommand({ platform: "win32" });
  const result = await executeControlTool(
    ctx("run_command", { command: "git status && npm test" }),
    { command },
  );
  assert.equal(result.executed, false);
  assert.match(result.output, /不支持 &&/);
  assert.equal(command.calls.some((item) => item.startsWith("command:")), false);
});
