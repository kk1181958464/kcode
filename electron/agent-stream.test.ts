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
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
      },
    ],
  });
  assert.equal(reasoning, "inspect first");
  assert.deepEqual(a.finish().calls[0], {
    id: "grok-call",
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
  assert.throws(
    () => a.assertStreamComplete(),
    /模型响应流意外中断/,
  );
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
  assert.throws(
    () => a.assertStreamComplete(),
    /工具调用参数不完整/,
  );
});

