import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionSummary } from "../src/components/conversation/ConversationView";
import { StatusPanel } from "../src/components/status/StatusPanel";
import type { AgentActivity } from "../src/types";

Object.assign(globalThis, { React });

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
  assert.match(markup, /\+12/);
  assert.match(markup, /-3/);
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
      selectedTarget: undefined,
      effortLabels: { auto: "自动" } as never,
      reasoningEffort: "auto",
      checkpoints: [],
      activeTask: undefined,
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
});
