import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  buildRuntimeCompactionLedger,
  buildRuntimeCompactionSource,
  compactRuntimeHistory,
  compactRuntimeHistoryWithModel,
  isRuntimeProtocolMessage,
  runAgent,
  type RunAgentDeps,
  type HistoryItem,
} from "./agent";

test(
  "recognizes a structured API protocol without treating ordinary URLs as one",
  () => {
    assert.equal(
      isRuntimeProtocolMessage(
        "请查看 https://example.com 的页面并告诉我标题，这只是普通网页阅读。",
      ),
      false,
    );
    assert.equal(
      isRuntimeProtocolMessage(
        [
          "Base URL: https://ai-studio.example/v1",
          "所有请求使用 JSON，Authorization: Bearer <API_KEY>",
          "POST /videos/generations，返回 status=processing，随后 GET /videos/{id}",
          '{"model":"seedance","status":"succeeded","data":[{"url":"..."}]}',
        ].join("\n"),
      ),
      true,
    );
  },
);

test("keeps the full protocol document when runtime history is compacted", () => {
  const protocol = [
    "接口协议说明",
    "Base URL: https://ai-studio.example/v1",
    'Authorization: Bearer <API_KEY> and Content-Type: application/json',
    "POST /videos/generations",
    '{"model":"seedance","prompt":"...","duration":5,"resolution":"720p"}',
    "创建任务返回 status=processing 和 id=job_xxx",
    "GET /videos/{JOB_ID}",
    '{"status":"succeeded","data":[{"url":"https://example.com/video.mp4"}]}',
    "任务完成后还必须读取 callback、usage 和错误字段，不能只依据模型文字判断。",
    "协议尾部字段必须保留：VIDEO_RESULT_URL_FIELD=video.url; POLL_SUCCESS_STATUS=succeeded; ENDPOINT_CHECK=/videos/{JOB_ID}",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "开始检查项目" },
    { kind: "message", role: "assistant", content: "我先读取接口" },
    { kind: "message", role: "user", content: protocol },
    ...Array.from({ length: 12 }, (_, index) => ({
      kind: "result" as const,
      callId: `call-${index}`,
      content: JSON.stringify({
        success: true,
        summary: `读取第 ${index} 项`,
        data: { path: `src/file-${index}.ts` },
        truncated: false,
      }),
    })),
  ];

  assert.equal(compactRuntimeHistory(history), true);
  const retained = history.find(
    (item) =>
      item.kind === "message" &&
      item.content.includes("<runtime_retained_protocol_context>"),
  );
  assert.ok(retained);
  assert.match(retained.content, /\/videos\/generations/);
  assert.match(retained.content, /\/videos\/\{JOB_ID\}/);
  assert.match(retained.content, /status.*succeeded/);
  assert.match(retained.content, /VIDEO_RESULT_URL_FIELD=video\.url/);

  // A second compaction must reuse the retained block instead of nesting it
  // or retaining the same protocol more than once.
  assert.equal(compactRuntimeHistory(history), true);
  const retainedBlocks = history.filter(
    (item) =>
      item.kind === "message" &&
      item.content.includes("<runtime_retained_protocol_context>"),
  );
  assert.equal(retainedBlocks.length, 1);
  assert.equal(
    (
      retainedBlocks[0].content.match(/<runtime_retained_protocol_context>/g) ??
      []
    ).length,
    1,
  );
  assert.match(retainedBlocks[0].content, /VIDEO_RESULT_URL_FIELD=video\.url/);
});

test("keeps only the explicitly current user image during forced runtime compaction", () => {
  const image = (id: string) => ({
    id,
    name: `${id}.png`,
    mediaType: "image/png" as const,
    dataUrl: "data:image/png;base64,AA==",
    size: 1,
  });
  const history: HistoryItem[] = [
    {
      kind: "message",
      id: "old-message",
      role: "user",
      content: "较早的截图",
      images: [image("old")],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "message" as const,
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `历史记录 ${index + 1}`,
    })),
    {
      kind: "message",
      id: "current-message",
      role: "user",
      content: "请分析最新截图",
      images: [image("latest")],
    },
  ];

  assert.equal(
    compactRuntimeHistory(history, true, [], 8, "current-message"),
    true,
  );
  const latest = history.find(
    (item) => item.kind === "message" && item.content === "请分析最新截图",
  );
  assert.equal(latest?.kind, "message");
  assert.equal(latest?.images?.[0]?.id, "latest");
  assert.equal(
    history.some(
      (item) => item.kind === "message" && item.images?.[0]?.id === "old",
    ),
    false,
  );
});

test("keeps the current image when it is the first runtime message", () => {
  const history: HistoryItem[] = [
    {
      kind: "message",
      id: "current-message",
      role: "user",
      content: "请分析这张图片",
      images: [
        {
          id: "current",
          name: "current.png",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
          size: 1,
        },
      ],
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `后续记录 ${index + 1}`,
    })),
  ];

  assert.equal(
    compactRuntimeHistory(history, true, [], 8, "current-message"),
    true,
  );
  const first = history[0];
  assert.equal(first.kind, "message");
  assert.equal(first.images?.[0]?.id, "current");
  assert.doesNotMatch(first.content, /runtime_image_context_removed/);
});

const fakeProvider = {
  id: "fake",
  name: "Fake",
  protocol: "openai-chat" as const,
  baseUrl: "https://example.invalid",
  enabled: true,
  models: [
    {
      id: "fake-model",
      modelId: "fake-model",
      displayName: "Fake",
      protocol: "openai-chat" as const,
    },
  ],
  apiKey: "sk-fake",
  apiKeys: ["sk-fake"],
};

const runtimeRequest = {
  providerId: "fake",
  modelId: "fake-model",
  messages: [{ role: "user" as const, content: "继续完成这个任务" }],
  permissionMode: "full-access" as const,
  workspacePath: "C:\\workspace",
  contextWindow: 100_000,
};

test("uses a model-generated handoff for runtime compaction", async () => {
  const protocol = [
    "Base URL: https://api.example.test/v1",
    "Authorization: Bearer <API_KEY>; Content-Type: application/json",
    "POST /jobs returns status=processing and id",
    "GET /jobs/{id} polls until status=succeeded",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "先检查项目" },
    { kind: "message", role: "assistant", content: "已读取配置和入口文件" },
    { kind: "message", role: "user", content: protocol },
    {
      kind: "calls",
      calls: [
        {
          id: "write-1",
          name: "write_file",
          input: { path: "src/app.ts" },
        },
      ],
      rawCalls: [],
    },
    {
      kind: "result",
      callId: "write-1",
      content: JSON.stringify({
        success: true,
        summary: "写入文件完成",
        data: {
          path: "src/app.ts",
          changed: true,
          additions: 12,
          deletions: 3,
        },
        truncated: false,
      }),
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `最近记录 ${index}`,
    })),
  ];
  const evidenceHistory = history.filter(
    (item) => item.kind === "calls" || item.kind === "result",
  );
  let receivedSource = "";
  const result = await compactRuntimeHistoryWithModel(history, {
    requestId: "runtime-model-compaction",
    request: runtimeRequest,
    provider: fakeProvider,
    evidenceHistory,
    summarize: async (args) => {
      receivedSource = args.source;
      return {
        summary: "模型整理：接口轮询约束和当前实现进度已保留。",
        ledger: args.ledger,
        modelGenerated: true,
        durationMs: 3,
        modelId: "fake-model",
      };
    },
  });

  assert.equal(result.strategy, "model");
  assert.equal(result.changed, true);
  assert.match(receivedSource, /jobs|status=succeeded/);
  assert.ok(receivedSource.includes("src/app.ts"));
  const modelSummary = history.find(
    (item) =>
      item.kind === "message" &&
      item.content.includes("<runtime_model_compaction>"),
  );
  assert.ok(modelSummary);
  assert.match(modelSummary.content, /模型整理：接口轮询约束/);
  assert.match(modelSummary.content, /runtime_verified_evidence/);
  assert.match(modelSummary.content, /src[\\/]app\.ts/);
});

test("falls back only when the compaction model fails", async () => {
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "任务目标" },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `历史 ${index} ${"x".repeat(120)}`,
    })),
  ];
  const result = await compactRuntimeHistoryWithModel(history, {
    requestId: "runtime-fallback-compaction",
    request: runtimeRequest,
    provider: fakeProvider,
    summarize: async () => {
      throw new Error("上游压缩模型不可用");
    },
  });
  assert.equal(result.strategy, "fallback");
  assert.equal(result.changed, true);
  assert.match(result.error ?? "", /压缩模型不可用/);
  assert.equal(
    history.some(
      (item) =>
        item.kind === "message" &&
        item.content.includes("<runtime_model_compaction>"),
    ),
    false,
  );
});

test("uses model compaction for a short history with oversized records", async () => {
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "先检查这个大型输出" },
    {
      kind: "message",
      role: "assistant",
      content: `早期结论 ${"a".repeat(4_000)}`,
    },
    {
      kind: "result",
      callId: "large-result",
      content: JSON.stringify({
        success: true,
        summary: "读取大型结果",
        data: { path: "src/large.ts", output: "b".repeat(4_000) },
        truncated: false,
      }),
    },
    { kind: "message", role: "assistant", content: "中间记录" },
    { kind: "message", role: "assistant", content: "最近一条记录" },
  ];
  let called = false;
  const result = await compactRuntimeHistoryWithModel(history, {
    requestId: "runtime-short-large-compaction",
    request: { ...runtimeRequest, contextWindow: 10_000 },
    provider: fakeProvider,
    summarize: async (args) => {
      called = true;
      assert.match(args.source, /早期结论/);
      assert.match(args.source, /src\/large\.ts/);
      return {
        summary: "模型已整理短历史中的大型输出。",
        ledger: args.ledger,
        modelGenerated: true,
        durationMs: 1,
        modelId: "fake-model",
      };
    },
  });
  assert.equal(called, true);
  assert.equal(result.strategy, "model");
  assert.ok(
    history.some(
      (item) =>
        item.kind === "message" &&
        item.content.includes("<runtime_model_compaction>"),
    ),
  );
});

test("runtime compaction source and ledger carry structured evidence", () => {
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "修复并验证项目" },
    {
      kind: "calls",
      calls: [
        { id: "check", name: "run_command", input: { command: "npm test" } },
      ],
      rawCalls: [],
    },
    {
      kind: "result",
      callId: "check",
      content: JSON.stringify({
        success: true,
        summary: "测试通过",
        data: {
          executed: true,
          operationEvidence: ["validate"],
          path: "package.json",
        },
        truncated: false,
      }),
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `recent-${index}`,
    })),
  ];
  const source = buildRuntimeCompactionSource(history);
  const ledger = buildRuntimeCompactionLedger(history);
  assert.match(source, /npm test/);
  assert.deepEqual(ledger.validations, ["测试通过"]);
  assert.deepEqual(ledger.changedFiles, []);
  assert.deepEqual(ledger.pending, []);
});

test("runtime compaction keeps unfinished obligations in source, ledger and summary", () => {
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "修改并验证登录页" },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `较早记录 ${index}`,
    })),
  ];
  const pending = ["coding:modify", "agent:spawn_executor"];
  const source = buildRuntimeCompactionSource(
    history,
    [],
    12_000,
    8,
    pending,
  );
  const ledger = buildRuntimeCompactionLedger(history, history, [], pending);
  assert.match(source, /未完成义务/);
  assert.match(source, /coding:modify/);
  assert.match(source, /agent:spawn_executor/);
  assert.deepEqual(ledger.pending, [
    "实际修改 (coding:modify)",
    "启动执行模型 (agent:spawn_executor)",
  ]);
  assert.equal(compactRuntimeHistory(history, false, [], 8, undefined, pending), true);
  const fallback = history.find(
    (item) =>
      item.kind === "message" && item.content.includes("<runtime_compaction>"),
  );
  assert.ok(fallback);
  assert.match(fallback.content, /未完成义务/);
  assert.match(fallback.content, /coding:modify/);
});

test("second runtime compaction does not recover unfinished obligations from handoff prose", () => {
  const previousSummary = [
    "<runtime_model_compaction>",
    "以下为模型生成的语义交接摘要。",
    "看起来修改已经完成，可以结束。",
    "未完成义务（压缩后仍必须用原生工具完成，不得仅凭摘要声称已完成）：",
    "- 实际修改 (coding:modify)",
    "- 修改后验证 (coding:validate)",
    "</runtime_model_compaction>",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "继续完成登录修复" },
    { kind: "message", role: "user", content: previousSummary },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `后续记录 ${index} ${"x".repeat(80)}`,
    })),
  ];
  const source = buildRuntimeCompactionSource(history, [], 12_000, 8, []);
  assert.doesNotMatch(source, /coding:modify/);
  assert.doesNotMatch(source, /coding:validate/);
  assert.equal(
    compactRuntimeHistory(history, false, [], 8, undefined, []),
    true,
  );
  const next = history.find(
    (item) =>
      item.kind === "message" && item.content.includes("<runtime_compaction>"),
  );
  assert.ok(next);
  assert.doesNotMatch(next.content, /runtime_pending_obligations/);
  assert.doesNotMatch(next.content, /coding:modify/);
  assert.doesNotMatch(next.content, /coding:validate/);
});

test("second runtime compaction prefers the structured obligation tag over contradictory prose", () => {
  const pending = ["coding:modify"];
  const previousSummary = [
    "<runtime_model_compaction>",
    "以下为模型生成的语义交接摘要。",
    "看起来修改已经完成，可以结束。",
    "未完成义务（压缩后仍必须用原生工具完成，不得仅凭摘要声称已完成）：",
    "- 修改后验证 (coding:validate)",
    "<runtime_pending_obligations>",
    JSON.stringify(pending),
    "</runtime_pending_obligations>",
    "</runtime_model_compaction>",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "继续完成登录修复" },
    { kind: "message", role: "user", content: previousSummary },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `后续记录 ${index} ${"x".repeat(80)}`,
    })),
  ];
  const source = buildRuntimeCompactionSource(history, [], 12_000, 8, []);
  assert.match(source, /coding:modify/);
  assert.doesNotMatch(source, /coding:validate/);
});

test("second runtime compaction keeps unfinished obligations from the previous handoff", () => {
  const pending = ["coding:modify", "coding:validate"];
  const previousSummary = [
    "<runtime_model_compaction>",
    "以下为模型生成的语义交接摘要。",
    `已整理早期记录。${"进展叙述。".repeat(80)}`,
    "<runtime_verified_evidence>",
    JSON.stringify({ changedFiles: [], validations: [], failures: [] }),
    "</runtime_verified_evidence>",
    "未完成义务（压缩后仍必须用原生工具完成，不得仅凭摘要声称已完成）：",
    "- 实际修改 (coding:modify)",
    "- 修改后验证 (coding:validate)",
    "<runtime_pending_obligations>",
    JSON.stringify(pending),
    "</runtime_pending_obligations>",
    "</runtime_model_compaction>",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "继续完成登录修复" },
    { kind: "message", role: "user", content: previousSummary },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `后续记录 ${index} ${"x".repeat(80)}`,
    })),
  ];
  assert.equal(
    compactRuntimeHistory(history, false, [], 8, undefined, pending),
    true,
  );
  const next = history.find(
    (item) =>
      item.kind === "message" && item.content.includes("<runtime_compaction>"),
  );
  assert.ok(next);
  assert.match(next.content, /未完成义务/);
  assert.match(next.content, /coding:modify/);
  assert.match(next.content, /coding:validate/);
  assert.match(next.content, /上次交接/);
});

test("second runtime compaction keeps the previous handoff outside the rolling fact window", () => {
  const pending = ["coding:modify"];
  const previousSummary = [
    "<runtime_model_compaction>",
    "以下为模型生成的语义交接摘要。",
    "登录页修改尚未落地。",
    "<runtime_verified_evidence>",
    JSON.stringify({ changedFiles: [], validations: [], failures: [] }),
    "</runtime_verified_evidence>",
    "<runtime_pending_obligations>",
    JSON.stringify(pending),
    "</runtime_pending_obligations>",
    "</runtime_model_compaction>",
  ].join("\n");
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "继续完成登录修复" },
    { kind: "message", role: "user", content: previousSummary },
    ...Array.from({ length: 90 }, (_, index) => ({
      kind: "result" as const,
      callId: `noise-${index}`,
      content: JSON.stringify({
        success: true,
        summary: `读取第 ${index} 项`,
        data: { path: `src/file-${index}.ts` },
        truncated: false,
      }),
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `recent-${index}`,
    })),
  ];
  const source = buildRuntimeCompactionSource(
    history,
    [],
    12_000,
    8,
    pending,
  );
  assert.match(source, /coding:modify/);
  assert.match(source, /上次运行交接|登录页修改尚未落地/);
  assert.equal(
    compactRuntimeHistory(history, false, [], 8, undefined, pending),
    true,
  );
  const next = history.find(
    (item) =>
      item.kind === "message" && item.content.includes("<runtime_compaction>"),
  );
  assert.ok(next);
  assert.match(next.content, /上次交接/);
  assert.match(next.content, /登录页修改尚未落地/);
  assert.match(next.content, /coding:modify/);
});

test("model compaction summary keeps structured unfinished obligations", async () => {
  const history: HistoryItem[] = [
    { kind: "message", role: "user", content: "修改并验证登录页" },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `较早记录 ${index}`,
    })),
  ];
  const pending = ["coding:modify"];
  const result = await compactRuntimeHistoryWithModel(history, {
    requestId: "runtime-model-pending-compaction",
    request: runtimeRequest,
    provider: fakeProvider,
    pendingOperations: pending,
    summarize: async (args) => {
      assert.match(args.source, /coding:modify/);
      assert.ok(args.ledger.pending.some((item) => item.includes("coding:modify")));
      return {
        summary: "看起来修改已经完成，可以结束。",
        ledger: { ...args.ledger, pending: [] },
        modelGenerated: true,
        durationMs: 1,
        modelId: "fake-model",
      };
    },
  });
  assert.equal(result.strategy, "model");
  const summary = history.find(
    (item) =>
      item.kind === "message" &&
      item.content.includes("<runtime_model_compaction>"),
  );
  assert.ok(summary);
  assert.match(summary.content, /runtime_pending_obligations/);
  assert.match(summary.content, /coding:modify/);
  assert.match(summary.content, /未完成义务/);
  assert.match(summary.content, /看起来修改已经完成/);
});

test("packs older records independently instead of dropping the middle", () => {
  const history: HistoryItem[] = [
    ...Array.from({ length: 6 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `record-${index} ${"x".repeat(1_600)}`,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: "message" as const,
      role: "assistant" as const,
      content: `recent-${index}`,
    })),
  ];
  const source = buildRuntimeCompactionSource(history, [], 12_000);
  assert.ok(source.length <= 12_000);
  for (let index = 0; index < 6; index += 1)
    assert.match(source, new RegExp(`record-${index}`));
});

test("runAgent wires model compaction into the live turn", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-live-model-compaction-"),
  );
  const request = {
    ...runtimeRequest,
    workspacePath,
    contextWindow: 50_000,
    messages: [
      { role: "user" as const, content: "继续执行这个任务" },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        content: `较早的执行记录 ${index} ${"x".repeat(900)}`,
      })),
    ],
  };
  let summaryCalls = 0;
  let modelSummaryReachedTurn = false;
  const deps: RunAgentDeps = {
    getProvider: async () => fakeProvider,
    summarizeRuntimeContext: async (args) => {
      summaryCalls += 1;
      assert.match(args.source, /较早的执行记录/);
      return {
        summary: "模型已整理早期执行记录。",
        ledger: args.ledger,
        modelGenerated: true,
        durationMs: 1,
        modelId: "fake-model",
      };
    },
    async *streamTurn(args) {
      modelSummaryReachedTurn = args.history.some(
        (item) =>
          item.kind === "message" &&
          item.content.includes("<runtime_model_compaction>"),
      );
      yield {
        type: "complete",
        turn: {
          text: "已根据整理后的上下文继续。",
          calls: [],
          rawCalls: [],
          usage: { input: 10, output: 5, cached: 0 },
        },
      };
    },
  };
  const events = [];
  for await (const event of runAgent(
    "live-model-compaction",
    request,
    new AbortController().signal,
    deps,
  ))
    events.push(event);
  assert.equal(summaryCalls, 1);
  assert.equal(modelSummaryReachedTurn, true);
  assert.ok(
    events.some(
      (event) =>
        event.type === "context_compaction" &&
        event.phase === "completed" &&
        event.strategy === "model",
    ),
  );
});

test("runAgent keeps unfinished obligations in live model compaction", async () => {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "kcode-live-pending-compaction-"),
  );
  const request = {
    ...runtimeRequest,
    workspacePath,
    contextWindow: 50_000,
    messages: [
      { role: "user" as const, content: "继续完成登录修复" },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        content: `较早的执行记录 ${index} ${"x".repeat(900)}`,
      })),
    ],
    recoveryPlan: {
      steps: [
        {
          step: "修改登录",
          status: "completed" as const,
          requires: ["modify" as const],
        },
      ],
      current: 0,
      requirementsDeclared: true,
    },
  };
  let pendingSeen = false;
  let wrote = false;
  const deps: RunAgentDeps = {
    getProvider: async () => fakeProvider,
    summarizeRuntimeContext: async (args) => {
      pendingSeen = args.ledger.pending.some((item) =>
        item.includes("coding:modify"),
      );
      assert.match(args.source, /coding:modify|实际修改/);
      return {
        summary: "模型已整理早期执行记录，修改仍未完成。",
        ledger: args.ledger,
        modelGenerated: true,
        durationMs: 1,
        modelId: "fake-model",
      };
    },
    async *streamTurn() {
      if (wrote) {
        yield {
          type: "complete",
          turn: {
            text: "已根据实际工具结果完成修改。",
            calls: [],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
        return;
      }
      if (pendingSeen) {
        wrote = true;
        yield {
          type: "complete",
          turn: {
            text: "现在执行缺少的修改。",
            calls: [
              {
                id: "pending-write",
                name: "write_file",
                input: { path: "login.ts", content: "fixed\n" },
              },
            ],
            rawCalls: [],
            usage: { input: 10, output: 5, cached: 0 },
          },
        };
        return;
      }
      yield {
        type: "complete",
        turn: {
          text: "旧上下文已经足够，可以直接结束。",
          calls: [],
          rawCalls: [],
          usage: { input: 10, output: 5, cached: 0 },
        },
      };
    },
  };
  const events = [];
  for await (const event of runAgent(
    "live-pending-compaction",
    request,
    new AbortController().signal,
    deps,
  ))
    events.push(event);
  assert.equal(pendingSeen, true);
  assert.equal(
    await readFile(path.join(workspacePath, "login.ts"), "utf8"),
    "fixed\n",
  );
  const done = events.find((event) => event.type === "done");
  assert.equal(done && "outcome" in done ? done.outcome : undefined, "completed");
});

test("includes current execution plan in compaction source", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    kind: "message" as const,
    role: "user" as const,
    content: `earlier work ${index} ${"x".repeat(120)}`,
  }));
  const source = buildRuntimeCompactionSource(
    history,
    [],
    40_000,
    4,
    ["coding:modify"],
    {
      steps: ["读代码", "改 UI", "跑测试"],
      statuses: ["completed", "in_progress", "pending"],
      cursor: 1,
    },
  );
  assert.match(source, /当前执行计划/);
  assert.match(source, /\[completed\] 读代码/);
  assert.match(source, /\[in_progress\] 改 UI/);
  assert.match(source, /\[pending\] 跑测试/);
});

