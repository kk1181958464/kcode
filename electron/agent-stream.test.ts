import test from "node:test";
import assert from "node:assert/strict";
import { AgentStreamAssembler } from "./agent-stream";

test("assembles fragmented OpenAI Chat tool calls", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "browser_", arguments: '{"ref"' },
            },
          ],
        },
      },
    ],
  });
  a.consume({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { name: "click", arguments: ':"r2"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  const result = a.finish();
  assert.deepEqual(result.calls, [
    { id: "c1", name: "browser_click", input: { ref: "r2" } },
  ]);
  assert.deepEqual(result.usage, { input: 10, output: 4, cached: 0 });
});
test("assembles Grok-compatible tool calls and reasoning", () => {
  let reasoning = "";
  const a = new AgentStreamAssembler(
    "openai-chat",
    undefined,
    (delta) => (reasoning += delta),
  );
  a.consume({
    choices: [
      {
        delta: {
          reasoning_content: "inspect first",
          tool_calls: [
            {
              index: 0,
              id: "grok-call",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(reasoning, "inspect first");
  const turn = a.finish();
  assert.equal(turn.reasoningContent, "inspect first");
  assert.equal(
    (turn.rawCalls[0] as any).message.reasoning_content,
    "inspect first",
  );
  assert.deepEqual(turn.calls[0], {
    id: "grok-call",
    name: "read_file",
    input: { path: "README.md" },
  });
});
test("normalizes GLM-compatible cumulative text and reasoning chunks", () => {
  let streamedText = "";
  let streamedReasoning = "";
  const a = new AgentStreamAssembler(
    "openai-chat",
    (delta) => (streamedText += delta),
    (delta) => (streamedReasoning += delta),
    { normalizeCumulativeChatChunks: true },
  );
  a.consume({
    choices: [
      {
        delta: {
          content: "确认工作区",
          reasoning_content: "先检查",
        },
      },
    ],
  });
  a.consume({
    choices: [
      {
        delta: {
          content: "确认工作区主文件",
          reasoning_content: "先检查文件",
        },
      },
    ],
  });
  a.consume({
    choices: [
      {
        delta: {
          content: "确认工作区主文件",
          reasoning_content: "先检查文件",
        },
      },
    ],
  });
  const result = a.finish();
  assert.equal(result.text, "确认工作区主文件");
  assert.equal(result.reasoningContent, "先检查文件");
  assert.equal(streamedText, result.text);
  assert.equal(streamedReasoning, result.reasoningContent);
});
test("keeps ordinary GLM-compatible delta chunks incremental", () => {
  const a = new AgentStreamAssembler("openai-chat", undefined, undefined, {
    normalizeCumulativeChatChunks: true,
  });
  a.consume({ choices: [{ delta: { content: "确认：" } }] });
  a.consume({ choices: [{ delta: { content: "工作区" } }] });
  a.consume({ choices: [{ delta: { content: "已更新" } }] });
  assert.equal(a.finish().text, "确认：工作区已更新");
});
test("auto-detects growing cumulative chunks from compatible relays", () => {
  const a = new AgentStreamAssembler("openai-chat", undefined, undefined, {
    chatChunkMode: "auto",
  });
  a.consume({ choices: [{ delta: { content: "正在读取" } }] });
  a.consume({ choices: [{ delta: { content: "正在读取工作区" } }] });
  a.consume({ choices: [{ delta: { content: "正在读取工作区" } }] });
  assert.equal(a.finish().text, "正在读取工作区");
});

test("auto mode preserves short ordinary delta chunks", () => {
  const a = new AgentStreamAssembler("openai-chat", undefined, undefined, {
    chatChunkMode: "auto",
  });
  a.consume({ choices: [{ delta: { content: "a" } }] });
  a.consume({ choices: [{ delta: { content: "apple" } }] });
  assert.equal(a.finish().text, "aapple");
});
test("routes inline thinking tags to reasoning across fragmented chunks", () => {
  let streamedText = "";
  let streamedReasoning = "";
  const a = new AgentStreamAssembler(
    "openai-chat",
    (delta) => (streamedText += delta),
    (delta) => (streamedReasoning += delta),
  );
  a.consume({ choices: [{ delta: { content: "先说明。<thi" } }] });
  a.consume({ choices: [{ delta: { content: "nking>检查仓库" } }] });
  a.consume({
    choices: [{ delta: { content: "状态</thinking>最终结论。" } }],
  });

  const result = a.finish();
  assert.equal(result.text, "先说明。最终结论。");
  assert.equal(result.reasoningContent, "检查仓库状态");
  assert.equal(streamedText, result.text);
  assert.equal(streamedReasoning, result.reasoningContent);
});
test("normalizes cumulative chunks before extracting inline thinking", () => {
  const a = new AgentStreamAssembler("openai-chat", undefined, undefined, {
    normalizeCumulativeChatChunks: true,
  });
  a.consume({
    choices: [{ delta: { content: "<thinking>检查" } }],
  });
  a.consume({
    choices: [
      {
        delta: {
          content: "<thinking>检查远程仓库</thinking>当前目录没有 Git。",
        },
      },
    ],
  });

  const result = a.finish();
  assert.equal(result.reasoningContent, "检查远程仓库");
  assert.equal(result.text, "当前目录没有 Git。");
});
test("preserves an incomplete literal think tag when the stream finishes", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({ choices: [{ delta: { content: "文档示例：<think" } }] });
  assert.equal(a.finish().text, "文档示例：<think");
});
test("normalizes GLM-compatible cumulative tool call chunks", () => {
  const a = new AgentStreamAssembler("openai-chat", undefined, undefined, {
    normalizeCumulativeChatChunks: true,
  });
  a.consume({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "glm-call",
              function: { name: "read_", arguments: '{"path"' },
            },
          ],
        },
      },
    ],
  });
  a.consume({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(a.finish().calls[0], {
    id: "glm-call",
    name: "read_file",
    input: { path: "README.md" },
  });
});
test("assembles Responses argument deltas", () => {
  const a = new AgentStreamAssembler("openai-responses");
  a.consume({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "function_call",
      call_id: "c2",
      name: "read_file",
      arguments: "",
    },
  });
  a.consume({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: '{"path":"',
  });
  a.consume({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: 'README.md"}',
  });
  assert.deepEqual(a.finish().calls[0], {
    id: "c2",
    name: "read_file",
    input: { path: "README.md" },
  });
});
test("surfaces reasoning deltas without adding them to answer text", () => {
  const protocols = [
    {
      protocol: "openai-chat" as const,
      event: {
        choices: [{ delta: { reasoning_content: "chat thought" } }],
      },
      expected: "chat thought",
    },
    {
      protocol: "openai-responses" as const,
      event: {
        type: "response.reasoning_summary_text.delta",
        delta: "responses thought",
      },
      expected: "responses thought",
    },
    {
      protocol: "anthropic-messages" as const,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "anthropic thought" },
      },
      expected: "anthropic thought",
    },
  ];

  for (const { protocol, event, expected } of protocols) {
    let reasoning = "";
    const assembler = new AgentStreamAssembler(
      protocol,
      undefined,
      (delta) => (reasoning += delta),
    );
    assembler.consume(event);
    assert.equal(reasoning, expected);
    assert.equal(assembler.finish().text, "");
  }
});
test("assembles Anthropic partial JSON and text", () => {
  let streamed = "";
  const a = new AgentStreamAssembler(
    "anthropic-messages",
    (delta) => (streamed += delta),
  );
  a.consume({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Working" },
  });
  a.consume({
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "tool_use",
      id: "c3",
      name: "write_file",
      input: {},
    },
  });
  a.consume({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"path":"a.txt",' },
  });
  a.consume({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"content":"ok"}' },
  });
  const result = a.finish();
  assert.equal(streamed, "Working");
  assert.deepEqual(result.calls[0].input, { path: "a.txt", content: "ok" });
});
test("assembles Gemini function calls", () => {
  const a = new AgentStreamAssembler("gemini-generate-content");
  a.consume({
    candidates: [
      {
        content: {
          parts: [
            { text: "Done" },
            { functionCall: { name: "git_status", args: {} } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
  });
  const result = a.finish();
  assert.equal(result.text, "Done");
  assert.equal(result.calls[0].name, "git_status");
});

test("detects silent stream interruption without completion marker", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({
    choices: [{ delta: { content: "half answer" } }],
  });
  assert.throws(() => a.assertStreamComplete(), /模型响应流意外中断/);
});

test("accepts finish_reason as stream completion", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({
    choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
  });
  a.assertStreamComplete();
  assert.equal(a.finish().text, "done");
});

test("accepts SSE [DONE] as stream completion", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({
    choices: [{ delta: { content: "ok" } }],
  });
  a.consume({ type: "__sse_done" });
  a.assertStreamComplete();
  assert.equal(a.finish().text, "ok");
});

test("detects incomplete tool call JSON as interruption", () => {
  const a = new AgentStreamAssembler("openai-chat");
  a.consume({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "read_file", arguments: '{"path":' },
            },
          ],
        },
      },
    ],
  });
  assert.throws(() => a.assertStreamComplete(), /工具调用参数不完整/);
});
