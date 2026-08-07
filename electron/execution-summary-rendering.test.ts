import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationHistory,
  ExecutionSummary,
} from "../src/components/conversation/ConversationView";
import { StatusPanel } from "../src/components/status/StatusPanel";
import type { AgentActivity } from "../src/types";

Object.assign(globalThis, { React });

function renderConversationRun(running: boolean, finalResponse = false) {
  const processText = "先检查工作区，再运行验证。\n\n";
  const activity: AgentActivity = {
    id: "activity-process",
    requestId: "request-process",
    tool: "run_command",
    status: "success",
    title: "运行验证",
    startedAt: 2_000,
    completedAt: 30_000,
    input: {},
    command: "npm test",
    textOffset: processText.length,
    agentRole: "executor",
    modelDisplayName: "GPT-5.6 Luna",
  };
  return renderToStaticMarkup(
    React.createElement(ConversationHistory, {
      messages: [
        {
          id: "assistant:request-process",
          role: "assistant",
          content: `${processText}最终结果：三个问题都已处理。`,
          createdAt: 1_000,
          completedAt: running ? undefined : 61_000,
          finalResponseOffset: finalResponse ? processText.length : undefined,
          finalResponseStartedAt: finalResponse ? 61_000 : undefined,
          model: "GPT-5.6 Sol",
        },
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      activitiesByRequest: new Map([["request-process", [activity]]]),
      runningId: running ? "request-process" : undefined,
      workspacePath: "D:/project/kcode",
      contextByMessage: new Map(),
      onRetry() {},
      onActivityChange() {},
      registerTurn() {},
      endRef: { current: null },
    }),
  );
}

test("keeps process output visible while the request is running", () => {
  const markup = renderConversationRun(true);
  assert.match(markup, /先检查工作区/);
  assert.match(markup, /execution-summary/);
  assert.doesNotMatch(markup, /completed-process-trigger/);
});

test("collapses completed process output and keeps only the final result visible", () => {
  const markup = renderConversationRun(false);
  assert.match(markup, /completed-process-trigger/);
  assert.match(markup, /已处理/);
  assert.match(markup, /1m 0s/);
  assert.match(markup, /1 个步骤/);
  assert.match(markup, /GPT-5\.6 Luna/);
  assert.match(markup, /最终结果：三个问题都已处理/);
  assert.doesNotMatch(markup, /先检查工作区/);
  assert.doesNotMatch(markup, /execution-summary/);
  assert.doesNotMatch(markup, /file-changes-summary/);
});

test("collapses process output as soon as the final response starts", () => {
  const markup = renderConversationRun(true, true);
  assert.match(markup, /completed-process-trigger/);
  assert.match(markup, /已处理/);
  assert.match(markup, /1m 0s/);
  assert.match(markup, /最终结果：三个问题都已处理/);
  assert.doesNotMatch(markup, /先检查工作区/);
  assert.doesNotMatch(markup, /execution-summary/);
});

test("shows the full running plan and concrete file changes while collapsed", () => {
  const planSteps = [
    "检查当前实现并确认处理范围",
    "修改相关文件并记录实际差异",
    "运行验证并核对最终结果",
  ];
  const activity: AgentActivity = {
    id: "activity-1",
    requestId: "request-1",
    tool: "apply_patch",
    status: "success",
    title: "应用补丁",
    startedAt: 1,
    completedAt: 2,
    input: { path: "src/App.tsx" },
    path: "src/App.tsx",
    additions: 12,
    deletions: 3,
    fileChanges: [
      { path: "src/App.tsx", additions: 12, deletions: 3, diff: "diff" },
    ],
    planSteps,
    planStep: 1,
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExecutionSummary, {
      activities: [activity],
      allActivities: [activity],
      running: true,
      isLatestGroup: true,
      requestFailed: false,
      hasLeadingNarration: true,
      hasTrailingNarration: false,
      requestId: "request-1",
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );

  assert.match(markup, /执行计划/);
  for (const step of planSteps) assert.match(markup, new RegExp(step));
  assert.match(markup, /execution-summary-file-breakdown compact/);
  assert.match(markup, /src\/App\.tsx/);
  assert.match(markup, /aria-label="查看 src\/App\.tsx 的改动"/);
  assert.match(markup, /execution-summary-file-row/);
  assert.match(markup, /aria-label="在文件资源管理器中显示 src\/App\.tsx"/);
  assert.match(markup, /\+12/);
  assert.match(markup, /-3/);
});

test("shows verified execution model evidence on delegated tool activity", () => {
  const spawnActivity: AgentActivity = {
    id: "spawn-1",
    requestId: "request-1",
    tool: "spawn_agent",
    status: "success",
    title: "启动执行模型 · GPT-5.6 Luna",
    startedAt: 1,
    completedAt: 2,
    input: { model: "GPT-5.6 Luna", task: "执行实现" },
  };
  const executorActivity: AgentActivity = {
    id: "executor-edit",
    requestId: "request-1",
    tool: "apply_patch",
    status: "success",
    title: "执行 Agent · 应用补丁",
    startedAt: 2,
    completedAt: 3,
    input: { path: "src/App.tsx" },
    path: "src/App.tsx",
    additions: 3,
    deletions: 1,
    agentRole: "executor",
    providerId: "kaka",
    modelId: "gpt-5.6-luna",
    modelDisplayName: "GPT-5.6 Luna",
    reasoningEffort: "high",
  };

  const markup = renderToStaticMarkup(
    React.createElement(ExecutionSummary, {
      activities: [spawnActivity, executorActivity],
      allActivities: [spawnActivity, executorActivity],
      running: true,
      isLatestGroup: true,
      requestFailed: false,
      hasLeadingNarration: true,
      hasTrailingNarration: false,
      requestId: "request-1",
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );

  assert.match(markup, /GPT-5\.6 Luna/);
  assert.match(markup, /GPT-5\.6 Luna · 高 执行/);
  assert.match(markup, /execution-summary-tool-model/);
  assert.match(markup, /已收到该执行模型的真实工具活动/);
});

test("offers a resource-manager action for downloaded local files", () => {
  const activity: AgentActivity = {
    id: "download-1",
    requestId: "request-download",
    tool: "ssh_download_file",
    status: "success",
    title: "从远程下载文件",
    startedAt: 1,
    completedAt: 2,
    input: {
      remotePath: "/tmp/report.txt",
      localPath: "D:/downloads/report.txt",
    },
    path: "D:/downloads/report.txt",
  };
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionSummary, {
      activities: [activity],
      allActivities: [activity],
      running: false,
      isLatestGroup: true,
      requestFailed: false,
      hasLeadingNarration: true,
      hasTrailingNarration: true,
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );

  assert.match(markup, /1 个文件/);
  assert.match(
    markup,
    /aria-label="在文件资源管理器中显示 D:\/downloads\/report\.txt"/,
  );
});

test("right rail uses only the current request changes instead of Git totals", () => {
  const activity: AgentActivity = {
    id: "current-edit",
    requestId: "request-current",
    tool: "apply_patch",
    status: "success",
    title: "应用补丁",
    startedAt: 1,
    completedAt: 2,
    input: {},
    path: "src/current.ts",
    additions: 2,
    deletions: 1,
    diff: "diff --git a/src/current.ts b/src/current.ts",
  };
  const markup = renderToStaticMarkup(
    React.createElement(StatusPanel, {
      runStatus: "completed",
      activities: [activity],
      selectedTarget: {
        provider: { name: "OpenAI" },
        model: {
          modelId: "gpt-5",
          displayName: "GPT-5",
          reasoningEfforts: ["low", "medium", "high"],
        },
      } as never,
      executorTarget: {
        provider: { name: "OpenAI" },
        model: {
          modelId: "gpt-5.5",
          displayName: "GPT-5.5",
          reasoningEfforts: ["low", "medium", "high"],
        },
      } as never,
      effortLabels: {
        auto: "自动",
        low: "轻度",
        medium: "中",
        high: "高",
      } as never,
      reasoningEffort: "medium",
      checkpoints: [],
      activeTask: {
        collaboration: {
          mode: "planner-executor",
          executorModelSelection: "openai|gpt-5.5",
        },
      } as never,
      runningId: undefined,
      summaryBusy: false,
      async resumeCheckpoint() {},
      gitRefreshing: false,
      async refreshGitState() {},
      gitState: {
        available: true,
        branch: "main",
        files: 9,
        additions: 99,
        deletions: 55,
        summary: " M src/old.ts",
        diff: "",
      },
      gitDiffOpen: false,
      setGitDiffOpen() {},
      durationMs: 1000,
      messages: [],
      usage: { input: 0, output: 0, cached: 0 },
      usageResolved: false,
      usedContextCount: 0,
      selectedContextWindow: undefined,
      contextTokens: 0,
      calibrationFactor: 1,
      compactActiveConversation() {},
      summaryOpen: false,
      setSummaryOpen() {},
      restoreSummarySnapshot() {},
      async rebuildActiveSummary() {},
      restoreFullContext() {},
    }),
  );

  assert.match(markup, /1 个文件/);
  assert.match(markup, /本轮改动/);
  assert.match(markup, /\+2/);
  assert.match(markup, /-1/);
  assert.doesNotMatch(markup, /工作区总计|src\/old\.ts|\+99|-55/);
  assert.match(markup, /规划 中 \/ 执行 中/);
});
