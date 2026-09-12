import assert from "node:assert/strict";
import test from "node:test";
import { parseModelResponse, parseStreamedTurn } from "./model-response-parser";
import { tools, validCalls } from "./agent-tool-schema";
import type { Protocol } from "../src/types";

const input = { path: "README.md" };
const fixtures: Array<{ protocol: Protocol; json: any; events: any[] }> = [
  {
    protocol: "openai-chat",
    json: {
      choices: [
        {
          message: {
            content: "Ready",
            tool_calls: [
              {
                id: "call1",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify(input),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    },
    events: [
      {
        choices: [
          {
            delta: {
              content: "Ready",
              tool_calls: [
                {
                  index: 0,
                  id: "call1",
                  function: { name: "read_", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "file", arguments: '"README.md"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ],
  },
  {
    protocol: "openai-responses",
    json: {
      output: [
        { type: "message", content: [{ type: "output_text", text: "Ready" }] },
        {
          type: "function_call",
          call_id: "call1",
          name: "read_file",
          arguments: JSON.stringify(input),
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 2 },
      },
    },
    events: [
      { type: "response.output_text.delta", delta: "Ready" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call1",
          name: "read_file",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '"README.md"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call1",
          name: "read_file",
          arguments: JSON.stringify(input),
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 2 },
          },
        },
      },
    ],
  },
  {
    protocol: "anthropic-messages",
    json: {
      content: [
        { type: "text", text: "Ready" },
        { type: "tool_use", id: "call1", name: "read_file", input },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    events: [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Ready" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call1",
          name: "read_file",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input),
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ],
  },
  {
    protocol: "gemini-generate-content",
    json: {
      candidates: [
        {
          content: {
            parts: [
              { text: "Ready" },
              { functionCall: { name: "read_file", args: input } },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 2,
      },
    },
    events: [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "Ready" },
                { functionCall: { name: "read_file", args: input } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 2,
        },
      },
    ],
  },
];

function response(events: any[]) {
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

for (const fixture of fixtures) {
  test(
    fixture.protocol +
      " retains text, tools and usage across JSON and SSE parsing",
    async () => {
      let visible = "";
      const streamed = await parseStreamedTurn(
        fixture.protocol,
        response(fixture.events),
        new AbortController().signal,
        (delta) => {
          visible += delta;
        },
      );
      const json = parseModelResponse(fixture.protocol, fixture.json);
      for (const turn of [streamed, json]) {
        assert.equal(turn.text, "Ready");
        assert.equal(turn.calls.length, 1);
        assert.ok(turn.calls[0].id);
        assert.equal(turn.calls[0].name, "read_file");
        assert.deepEqual(turn.calls[0].input, input);
        assert.deepEqual(turn.usage, {
          input: 10,
          output: 4,
          cached: fixture.protocol === "anthropic-messages" ? 0 : 2,
        });
        assert.ok(turn.rawCalls.length > 0);
      }
      assert.equal(visible, "Ready");
    },
  );
}

test("legacy credentials remain readable but are not advertised", () => {
  const calls = [{ id: "legacy", name: "credential_save" as const, input: {} }];
  assert.equal(validCalls(calls), calls);
  assert.ok(!tools.some((tool) => (tool.name as string) === "credential_save"));
});

test("rejects unknown tools and broken arguments at the parser boundary", async () => {
  assert.throws(
    () =>
      parseModelResponse("openai-chat", {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "bad",
                  function: { name: "missing_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    /missing_tool/,
  );
  await assert.rejects(
    parseStreamedTurn(
      "openai-chat",
      response([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "bad",
                    index: 0,
                    function: { name: "read_file", arguments: "{" },
                  },
                ],
              },
            },
          ],
        },
      ]),
      new AbortController().signal,
    ),
  );
});

test("Responses failures never become successful empty turns", async () => {
  await assert.rejects(
    parseStreamedTurn(
      "openai-responses",
      response([
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "fixture upstream failure" },
          },
        },
      ]),
      new AbortController().signal,
    ),
  );
});
