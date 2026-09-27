import assert from "node:assert/strict";
import test from "node:test";
import { buildChatHistory } from "../src/app/chat-request";
import { prepareChatContext } from "../src/app/prepare-chat-context";
import { summarySnapshot } from "../src/app/useConversationContext";
import { previewProviders } from "../src/lib/model-utils";
import type { TaskRecord } from "../src/models";
import type { ChatMessage, ContextLedger, ImageAttachment } from "../src/types";

const ledger: ContextLedger = {
  goals: [],
  decisions: [],
  changedFiles: [],
  validations: [],
  failures: [],
  pending: [],
  connections: [],
};
function task(): TaskRecord {
  return {
    id: "a",
    name: "A",
    workspacePath: "D:/fixture",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    activities: [],
  };
}
const image: ImageAttachment = {
  id: "image",
  name: "image.png",
  mediaType: "image/png",
  dataUrl: "data:image/png;base64,AAAA",
  size: 3,
};

test("request history keeps retained evidence, summary and current-image order", () => {
  const messages: ChatMessage[] = [
    { id: "old", role: "user", content: "compacted", createdAt: 1 },
    {
      id: "partial",
      role: "assistant",
      content: "already inspected",
      createdAt: 2,
    },
    {
      id: "current",
      role: "user",
      content: "continue",
      createdAt: 3,
      images: [image],
    },
  ];
  const before = structuredClone(messages);
  const history = buildChatHistory({
    nextMessages: messages,
    compactedCount: 1,
    contextByMessage: new Map([
      [
        "current",
        [
          {
            id: "evidence",
            name: "evidence.txt",
            path: "evidence.txt",
            size: 5,
            content: "proof",
          },
        ],
      ],
    ]),
    designByMessage: new Map(),
    resumingInterruptedRun: true,
    currentUserId: "current",
    requestSummary: "prior work",
    requestLedger: ledger,
    retainedContext: "retained evidence",
  });
  assert.equal(history[0].content, "retained evidence");
  assert.match(history[1].content, /conversation_summary/);
  assert.match(history[1].content, /fact_ledger/);
  assert.equal(history[2].content, "already inspected");
  assert.match(history[3].content, /evidence.txt/);
  assert.match(history[3].content, /interrupted_turn_recovery/);
  assert.deepEqual(history[3].images, [image]);
  assert.equal(
    history.filter((x) => x.content.includes("interrupted_turn_recovery"))
      .length,
    1,
  );
  assert.deepEqual(messages, before);
});

test("ordinary requests do not inject recovery instructions into old messages", () => {
  const history = buildChatHistory({
    nextMessages: [
      { id: "user", role: "user", content: "hello", createdAt: 1 },
    ],
    compactedCount: 0,
    contextByMessage: new Map(),
    designByMessage: new Map(),
    resumingInterruptedRun: false,
    currentUserId: "user",
    retainedContext: "",
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].content, "hello");
});

test("context preparation reopens a stale window to retain the current image", async () => {
  const current: ChatMessage = {
    id: "image-user",
    role: "user",
    content: "inspect",
    createdAt: 1,
    images: [image],
  };
  const requestTask = {
    ...task(),
    compactedMessageCount: 3,
    messages: [current],
  };
  const target = {
    provider: previewProviders[0],
    model: { ...previewProviders[0].models[0], contextWindow: 100_000 },
  };
  const result = await prepareChatContext({
    requestTask,
    taskSelection: "preview|model",
    target,
    nextMessages: [current],
    user: current,
    requestFiles: [],
    defaultReasoningEffort: "auto",
    tokenCalibration: {},
    summarizeConversation: async () => {
      throw new Error("unexpected compaction");
    },
    setTasks: () => {
      throw new Error("unexpected task mutation");
    },
  });
  assert.equal(result.compactedCount, 0);
});

test("request budgeting uses prompt tokens rather than accumulated billing tokens", async () => {
  const current: ChatMessage = {
    id: "user",
    role: "user",
    content: "short prompt",
    createdAt: 1,
  };
  const requestTask = {
    ...task(),
    usage: { input: 1_000_000, output: 100, cached: 0, promptTokens: 800 },
  };
  const target = {
    provider: previewProviders[0],
    model: { ...previewProviders[0].models[0], contextWindow: 100_000 },
  };
  const result = await prepareChatContext({
    requestTask,
    taskSelection: "preview|model",
    target,
    nextMessages: [current],
    user: current,
    requestFiles: [],
    defaultReasoningEffort: "auto",
    tokenCalibration: {},
    summarizeConversation: async () => {
      throw new Error("billing total must not trigger compaction");
    },
    setTasks: () => {
      throw new Error("unexpected task mutation");
    },
  });
  assert.equal(result.contextNotice, "");
  assert.equal(result.compactedCount, 0);
});

test("summary snapshots retain three newest versions without mutating prior history", () => {
  const previous = [1, 2, 3].map((n) => ({
    id: String(n),
    createdAt: n,
    summary: "old-" + n,
    ledger,
    modelGenerated: false,
  }));
  const original = structuredClone(previous);
  const snapshots = summarySnapshot({
    ...task(),
    contextSummary: "new",
    compactedMessageCount: 4,
    summarySnapshots: previous,
  });
  assert.deepEqual(
    snapshots.map((x) => x.summary),
    ["new", "old-1", "old-2"],
  );
  assert.equal(snapshots[0].compactedMessageCount, 4);
  assert.deepEqual(previous, original);
});
