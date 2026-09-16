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
  assert.match(markup, /跑了测试/);
  assert.match(markup, /1m 0s/);
  assert.match(markup, /GPT-5\.6 Luna/);
  assert.match(markup, /最终结果：三个问题都已处理/);
  assert.doesNotMatch(markup, /先检查工作区/);
  assert.doesNotMatch(markup, /execution-summary/);
  assert.doesNotMatch(markup, /file-changes-summary/);
});

test("uses structured completion evidence for paused file totals", () => {
  const processText = "正在修改多个文件。\n\n";
  const activity: AgentActivity = {
    id: "activity-partial-file",
    requestId: "request-paused-summary",
    tool: "write_file",
    status: "success",
    title: "写入文件",
    startedAt: 2_000,
    completedAt: 3_000,
    input: { path: "src/one.ts" },
    path: "src/one.ts",
    additions: 0,
    deletions: 0,
    textOffset: processText.length,
  };
  const markup = renderToStaticMarkup(
    React.createElement(ConversationHistory, {
      messages: [
        {
          id: "assistant:request-paused-summary",
          role: "assistant",
          content: `${processText}模型未返回最终正文，已有结果已保留。`,
          createdAt: 1_000,
          completedAt: 4_000,
          finalResponseOffset: processText.length,
          finalResponseStartedAt: 3_000,
          model: "GPT-5.6 Sol",
          completionResult: {
            kind: "incomplete",
            operations: ["coding:modify"],
            missingOperations: [],
            toolCalls: 3,
            successfulTools: 2,
            failedTools: 1,
            changedFiles: ["src/one.ts", "src/two.ts"],
            additions: 9,
            deletions: 3,
            notice: "模型没有返回最终正文。",
          },
        },
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      activitiesByRequest: new Map([["request-paused-summary", [activity]]]),
      workspacePath: "D:/project/kcode",
      contextByMessage: new Map(),
      onRetry() {},
      onActivityChange() {},
      registerTurn() {},
      endRef: { current: null },
    }),
  );

  assert.match(markup, /未完成/);
  assert.match(markup, /2 个文件/);
  assert.match(markup, /\+9/);
  assert.match(markup, /-3/);
});

test("collapses process output as soon as the final response starts", () => {
  const markup = renderConversationRun(true, true);
  assert.match(markup, /completed-process-trigger/);
  assert.match(markup, /跑了测试/);
  assert.match(markup, /1m 0s/);
  assert.match(markup, /最终结果：三个问题都已处理/);
  assert.doesNotMatch(markup, /先检查工作区/);
  assert.doesNotMatch(markup, /execution-summary/);
});

test("collapses a corrected text-only attempt above the final answer", () => {
  const processText = "旧结论：文件已经上传成功。\n\n";
  const markup = renderToStaticMarkup(
    React.createElement(ConversationHistory, {
      messages: [
        {
          id: "assistant:text-correction",
          role: "assistant",
          content: `${processText}最终结论：手机端需要原生后台能力。`,
          createdAt: 1_000,
          completedAt: 4_000,
          finalResponseOffset: processText.length,
          finalResponseStartedAt: 3_000,
          finalResponseProcess: "correction",
          model: "GPT-5.6 Sol",
        },
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      activitiesByRequest: new Map(),
      workspacePath: "D:/project/kcode",
      contextByMessage: new Map(),
      onRetry() {},
      onActivityChange() {},
      registerTurn() {},
      endRef: { current: null },
    }),
  );

  assert.match(markup, /completed-process-trigger/);
  assert.match(markup, /已处理/);
  assert.match(markup, /最终结论：手机端需要原生后台能力/);
  assert.doesNotMatch(markup, /旧结论：文件已经上传成功/);
  assert.doesNotMatch(markup, /0 个步骤/);
});

test("keeps ordinary text auto-continuation fully visible", () => {
  const firstPart = "第一段长回答。";
  const markup = renderToStaticMarkup(
    React.createElement(ConversationHistory, {
      messages: [
        {
          id: "assistant:auto-continue",
          role: "assistant",
          content: `${firstPart}第二段续写。`,
          createdAt: 1_000,
          completedAt: 4_000,
          finalResponseOffset: firstPart.length,
          finalResponseStartedAt: 3_000,
          model: "GPT-5.6 Sol",
        },
      ],
      hasOlderMessages: false,
      hasNewerMessages: false,
      activitiesByRequest: new Map(),
      workspacePath: "D:/project/kcode",
      contextByMessage: new Map(),
      onRetry() {},
      onActivityChange() {},
      registerTurn() {},
      endRef: { current: null },
    }),
  );

  assert.match(markup, /第一段长回答/);
  assert.match(markup, /第二段续写/);
  assert.doesNotMatch(markup, /completed-process-trigger/);
});

test("keeps the running plan collapsed and still shows concrete file changes", () => {
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

  // Default: one-line head. Live row only while a tool is actively running.
  assert.match(markup, /execution-summary-head/);
  assert.match(markup, /第 2 \/\s*3 步/);
  assert.doesNotMatch(markup, /execution-summary-live/);
  assert.doesNotMatch(markup, /execution-plan-progress/);
  assert.doesNotMatch(markup, /执行计划/);
  assert.doesNotMatch(markup, /execution-summary-file-breakdown/);
  assert.doesNotMatch(markup, /execution-summary-toolline/);
  for (const step of [planSteps[0], planSteps[2]]) {
    assert.doesNotMatch(markup, new RegExp(step));
  }
  // Diff totals stay in the head stats.
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
  assert.match(markup, /已收到该执行模型的真实工具活动/);
  // Tool chips (incl. model badge) are expand-only now.
  assert.doesNotMatch(markup, /execution-summary-tool-model/);
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
  // Reveal-in-folder lives in the expanded file list now.
  assert.doesNotMatch(
    markup,
    /aria-label="在文件资源管理器中显示 D:\/downloads\/report\.txt"/,
  );
  assert.doesNotMatch(markup, /execution-summary-file-breakdown/);
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

  assert.match(markup, /aria-label="工作面板"/);
  assert.doesNotMatch(markup, /role="tablist"/);
  assert.match(markup, /aria-label="改动"/);
  assert.match(markup, /aria-label="本轮"/);
  assert.match(markup, /aria-label="上下文"/);
  assert.match(markup, /1 个文件/);
  assert.match(markup, /本轮改动/);
  assert.match(markup, /\+2/);
  assert.match(markup, /-1/);
  assert.match(markup, /status-file-row/);
  assert.match(markup, /弹窗查看 src\/current\.ts/);
  assert.doesNotMatch(markup, /aria-label="本轮差异"|git-diff-layer|查看文件更新/);
  assert.doesNotMatch(markup, /diff --git a\/src\/current\.ts/);
  assert.doesNotMatch(markup, /工作区总计|src\/old\.ts|\+99|-55/);
  // Current-model footer was removed from the right StatusPanel.
  assert.doesNotMatch(markup, /status-model-line|规划 中 \/ 执行 中|GPT-5\.5/);
  assert.doesNotMatch(markup, />GPT-5</);
});

test("right rail keeps recovery checkpoints on the current-run pane", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StatusPanel, {
      runStatus: "paused",
      activities: [],
      selectedTarget: undefined,
      effortLabels: {
        auto: "自动",
        low: "轻度",
        medium: "中",
        high: "高",
      } as never,
      reasoningEffort: "medium",
      checkpoints: [
        {
          id: "checkpoint-1",
          taskId: "task-1",
          startedAt: 1_700_000_000_000,
          status: "paused",
          request: { modelId: "gpt-5" },
        } as never,
      ],
      activeTask: { id: "task-1" } as never,
      runningId: undefined,
      summaryBusy: false,
      async resumeCheckpoint() {},
      gitRefreshing: false,
      async refreshGitState() {},
      gitState: {
        available: false,
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
      calibrationFactor: 1,
      compactActiveConversation() {},
      summaryOpen: false,
      setSummaryOpen() {},
      restoreSummarySnapshot() {},
      async rebuildActiveSummary() {},
      restoreFullContext() {},
    }),
  );

  assert.match(markup, /可恢复任务/);
  assert.match(markup, /从检查点继续/);
  const changesPane = markup.slice(
    markup.indexOf('aria-label="改动"'),
    markup.indexOf('aria-label="本轮"'),
  );
  const runPane = markup.slice(
    markup.indexOf('aria-label="本轮"'),
    markup.indexOf('aria-label="上下文"'),
  );
  assert.doesNotMatch(changesPane, /可恢复任务|从检查点继续/);
  assert.match(runPane, /可恢复任务|从检查点继续/);
});

test("changes pane exposes per-file Keep/Undo and edit checkpoints", () => {
  const activity: AgentActivity = {
    id: "activity-review",
    requestId: "request-review",
    tool: "write_file",
    status: "success",
    title: "写入文件",
    startedAt: 1,
    completedAt: 2,
    input: {},
    path: "src/review.ts",
    additions: 3,
    deletions: 1,
    undoable: true,
    diff: "diff --git a/src/review.ts b/src/review.ts",
  };
  const markup = renderToStaticMarkup(
    React.createElement(StatusPanel, {
      runStatus: "completed",
      activities: [activity],
      selectedTarget: undefined,
      effortLabels: {
        auto: "自动",
        low: "轻度",
        medium: "中",
        high: "高",
      } as never,
      reasoningEffort: "medium",
      checkpoints: [],
      editCheckpoints: [
        {
          id: "edit-cp-request-review",
          requestId: "request-review",
          label: "本轮改动前",
          createdAt: 1_700_000_000_000,
          fileCount: 1,
          paths: ["src/review.ts"],
        },
      ],
      activeTask: { id: "task-1" } as never,
      runningId: undefined,
      summaryBusy: false,
      async resumeCheckpoint() {},
      async keepFileChanges() {},
      async undoFileChanges() {},
      async restoreEditCheckpoint() {},
      gitRefreshing: false,
      async refreshGitState() {},
      gitState: {
        available: false,
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
      calibrationFactor: 1,
      compactActiveConversation() {},
      summaryOpen: false,
      setSummaryOpen() {},
      restoreSummarySnapshot() {},
      async rebuildActiveSummary() {},
      restoreFullContext() {},
    }),
  );

  assert.match(markup, /aria-label="改动审查"/);
  assert.match(markup, /全部保留/);
  assert.match(markup, /全部撤销/);
  assert.match(markup, /aria-label="保留 src\/review\.ts"/);
  assert.match(markup, /aria-label="撤销 src\/review\.ts"/);
  assert.match(markup, /aria-label="文件还原点"/);
  assert.match(markup, /本轮改动前/);
  assert.match(markup, /不删除对话/);
  const changesPane = markup.slice(
    markup.indexOf('aria-label="改动"'),
    markup.indexOf('aria-label="本轮"'),
  );
  assert.match(changesPane, /文件还原点|本轮改动前/);
});

test("defers bulky execution summary while a non-UI tool is running", () => {
  const activity: AgentActivity = {
    id: "activity-live-read",
    requestId: "request-live",
    tool: "read_file",
    status: "running",
    title: "读取文件",
    startedAt: 1,
    input: { path: "src/a.ts" },
    path: "src/a.ts",
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
      requestId: "request-live",
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );
  assert.equal(markup, "");
});

test("keeps waiting approval cards visible instead of deferring", () => {
  const activity: AgentActivity = {
    id: "activity-wait",
    requestId: "request-wait",
    tool: "run_command",
    status: "waiting",
    title: "运行命令",
    startedAt: 1,
    input: {},
    command: "npm test",
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
      requestId: "request-wait",
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );
  assert.match(markup, /execution-summary/);
  assert.match(markup, /等待确认/);
});

test("settled execution summary uses a past-tense receipt headline", () => {
  const activities: AgentActivity[] = [
    {
      id: "r1",
      requestId: "request-receipt",
      tool: "read_file",
      status: "success",
      title: "读取文件",
      startedAt: 1,
      completedAt: 2,
      input: { path: "src/a.ts" },
      path: "src/a.ts",
    },
    {
      id: "r2",
      requestId: "request-receipt",
      tool: "read_file",
      status: "success",
      title: "读取文件",
      startedAt: 2,
      completedAt: 3,
      input: { path: "src/b.ts" },
      path: "src/b.ts",
    },
    {
      id: "r3",
      requestId: "request-receipt",
      tool: "read_file",
      status: "success",
      title: "读取文件",
      startedAt: 3,
      completedAt: 4,
      input: { path: "src/c.ts" },
      path: "src/c.ts",
    },
    {
      id: "t1",
      requestId: "request-receipt",
      tool: "run_command",
      status: "success",
      title: "运行测试",
      startedAt: 4,
      completedAt: 5,
      input: {},
      command: "npm test",
    },
  ];
  const markup = renderToStaticMarkup(
    React.createElement(ExecutionSummary, {
      activities,
      allActivities: activities,
      running: false,
      isLatestGroup: true,
      requestFailed: false,
      hasLeadingNarration: true,
      hasTrailingNarration: true,
      workspacePath: "D:/project/kcode",
      onActivityChange() {},
    }),
  );
  assert.match(markup, /读了 3 个文件/);
  assert.match(markup, /跑了测试/);
});
