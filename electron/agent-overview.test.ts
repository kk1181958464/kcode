import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAgentOverviewBoard,
  mapCloudAgentRow,
  phaseFromSubagentStatus,
  phaseFromTaskRunStatus,
  subagentRowsFromActivities,
} from "../src/agent-overview";
import { StatusPanel } from "../src/components/status/StatusPanel";
import type { AgentActivity } from "../src/types";

Object.assign(globalThis, { React });

function task(
  overrides: Partial<Parameters<typeof buildAgentOverviewBoard>[0]["tasks"][number]> & {
    id: string;
    name: string;
  },
) {
  return {
    workspacePath: "/tmp/demo",
    updatedAt: 1000,
    activities: [],
    ...overrides,
  };
}

test("phaseFromTaskRunStatus maps running blocked paused completed", () => {
  assert.equal(phaseFromTaskRunStatus("running"), "running");
  assert.equal(phaseFromTaskRunStatus("idle", "req-1"), "running");
  assert.equal(phaseFromTaskRunStatus("blocked"), "waiting");
  assert.equal(phaseFromTaskRunStatus("paused"), "waiting");
  assert.equal(phaseFromTaskRunStatus("completed"), "done");
  assert.equal(phaseFromTaskRunStatus("failed"), "failed");
  assert.equal(phaseFromTaskRunStatus("cancelled"), "stopped");
  assert.equal(phaseFromTaskRunStatus("idle"), "idle");
});

test("phaseFromSubagentStatus covers tool statuses", () => {
  assert.equal(phaseFromSubagentStatus("running"), "running");
  assert.equal(phaseFromSubagentStatus("stopping"), "running");
  assert.equal(phaseFromSubagentStatus("waiting"), "waiting");
  assert.equal(phaseFromSubagentStatus("completed"), "done");
  assert.equal(phaseFromSubagentStatus("failed"), "failed");
});

test("buildAgentOverviewBoard lists only running/waiting and skips done stopped idle", () => {
  const board = buildAgentOverviewBoard({
    activeTaskId: "t-active",
    tasks: [
      task({
        id: "t-run",
        name: "修复登录",
        runStatus: "running",
        runningId: "r1",
        updatedAt: 3000,
      }),
      task({
        id: "t-wait",
        name: "等确认",
        runStatus: "blocked",
        updatedAt: 2000,
      }),
      task({
        id: "t-done",
        name: "已完成会话",
        runStatus: "completed",
        updatedAt: 2800,
      }),
      task({
        id: "t-stopped",
        name: "已停止会话",
        runStatus: "cancelled",
        updatedAt: 2700,
      }),
      task({
        id: "t-idle",
        name: "旧空闲",
        runStatus: "idle",
        updatedAt: 500,
      }),
      task({
        id: "t-arch",
        name: "已归档运行",
        runStatus: "running",
        runningId: "r2",
        archived: true,
        updatedAt: 4000,
      }),
      task({
        id: "t-active",
        name: "当前会话",
        runStatus: "idle",
        updatedAt: 2500,
      }),
    ],
  });

  assert.equal(board.cloudUnavailable, true);
  assert.equal(board.runningCount, 1);
  assert.equal(board.waitingCount, 1);
  const names = board.rows.map((row) => row.name);
  assert.deepEqual(names.sort(), ["修复登录", "等确认"].sort());
  assert.ok(!names.includes("当前会话"));
  assert.ok(!names.includes("已完成会话"));
  assert.ok(!names.includes("已停止会话"));
  assert.ok(!names.includes("旧空闲"));
  assert.ok(!names.includes("已归档运行"));
  const running = board.rows.find((row) => row.id === "session:t-run");
  assert.equal(running?.phaseLabel, "运行中");
  assert.equal(running?.locationLabel, "本地");
  assert.equal(running?.roleLabel, "会话");
});

test("SSH remote sessions are labeled honestly and collaboration shows planner role", () => {
  const board = buildAgentOverviewBoard({
    tasks: [
      task({
        id: "t-ssh",
        name: "远程部署",
        runStatus: "running",
        runningId: "r",
        collaboration: {
          mode: "planner-executor",
          executorModelSelection: "p|m",
        },
        remoteWorkspace: {
          id: "ssh-1",
          host: "box.example",
          port: 22,
          username: "dev",
          rootPath: "/srv/app",
        } as never,
      }),
    ],
  });
  const row = board.rows[0];
  assert.equal(row.location, "ssh-remote");
  assert.equal(row.locationLabel, "SSH 远程");
  assert.equal(row.role, "planner");
  assert.equal(row.roleLabel, "规划");
  assert.match(row.detail || "", /dev@box\.example/);
});

test("subagent activities become nested overview rows focused on parent task", () => {
  const activities: AgentActivity[] = [
    {
      id: "a1",
      requestId: "r1",
      tool: "run_command",
      status: "running",
      title: "跑测试",
      startedAt: 10,
      input: {},
      subagentId: "sub-1",
      subagentName: "测试员",
    },
    {
      id: "a2",
      requestId: "r1",
      tool: "spawn_agent",
      status: "success",
      title: "派发审查",
      startedAt: 5,
      completedAt: 8,
      input: { name: "审查员" },
    },
  ];
  const rows = subagentRowsFromActivities(
    task({ id: "t1", name: "父会话", activities, updatedAt: 20 }),
    "t1",
  );
  assert.equal(rows.length, 2);
  const tester = rows.find((row) => row.name === "测试员");
  assert.equal(tester?.phase, "running");
  assert.equal(tester?.taskId, "t1");
  assert.equal(tester?.focusable, true);
  assert.ok(rows.some((row) => row.name === "审查员"));
});

test("cloud rows only appear when provided — no fake cloud data by default", () => {
  const empty = buildAgentOverviewBoard({
    tasks: [task({ id: "t1", name: "本地", runStatus: "running", runningId: "r" })],
  });
  assert.equal(empty.cloudUnavailable, true);
  assert.equal(empty.cloudCount, 0);

  const withCloud = buildAgentOverviewBoard({
    cloudAvailable: true,
    cloudAgents: [
      mapCloudAgentRow({
        id: "c1",
        name: "云端构建",
        phase: "running",
        detail: "us-west",
        relatedUrl: "https://example.com/jobs/1",
      }),
    ],
    tasks: [],
  });
  assert.equal(withCloud.cloudUnavailable, false);
  assert.equal(withCloud.cloudCount, 1);
  assert.equal(withCloud.rows[0].locationLabel, "云端");
});

test("StatusPanel renders 智能体总览 and focuses session on click affordance", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StatusPanel, {
      runStatus: "idle",
      activities: [],
      selectedTarget: undefined,
      effortLabels: {
        auto: "自动",
        low: "轻度",
        medium: "中",
        high: "高",
      } as never,
      reasoningEffort: "medium",
      checkpoints: [],
      activeTask: {
        id: "t-active",
        name: "当前",
        workspacePath: "/tmp",
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        activities: [],
      } as never,
      runningId: undefined,
      summaryBusy: false,
      async resumeCheckpoint() {},
      gitRefreshing: false,
      async refreshGitState() {},
      gitState: {
        available: false,
        branch: "",
        files: 0,
        additions: 0,
        deletions: 0,
        summary: "",
        diff: "",
      },
      durationMs: 0,
      messages: [],
      usage: { input: 0, output: 0, cached: 0 },
      usageResolved: false,
      usedContextCount: 0,
      selectedContextWindow: undefined,
      contextTokens: 0,
      contextTokenSource: "estimated",
      nextRequestTokens: 0,
      contextWindowEstimated: true,
      calibrationFactor: 1,
      compactActiveConversation() {},
      summaryOpen: false,
      setSummaryOpen() {},
      restoreSummarySnapshot() {},
      async rebuildActiveSummary() {},
      restoreFullContext() {},
      overviewTasks: [
        {
          id: "t-run",
          name: "并行修复",
          workspacePath: "/tmp/a",
          updatedAt: 9,
          runStatus: "running",
          runningId: "req",
          activities: [],
        },
        {
          id: "t-active",
          name: "当前",
          workspacePath: "/tmp",
          updatedAt: 8,
          runStatus: "idle",
          activities: [],
        },
      ],
      onFocusOverviewSession() {},
    }),
  );

  assert.match(markup, /aria-label="智能体总览"/);
  assert.match(markup, /智能体总览/);
  assert.match(markup, /并行修复/);
  assert.match(markup, /运行中/);
  assert.ok(!markup.includes(">当前</"));
  assert.match(markup, /云端智能体尚未接入/);
  assert.match(markup, /data-extension="cloud-agents"/);
  assert.match(markup, /切换到会话：并行修复/);
  assert.match(markup, /agent-overview-board/);
});
