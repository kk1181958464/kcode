import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAnthropicMessagesEvent,
  parseChatCompletionsEvent,
  parseResponsesEvent,
} from "./protocols";

test("parses Responses API text and usage events", () => {
  assert.deepEqual(
    parseResponsesEvent({ type: "response.output_text.delta", delta: "hello" }),
    { events: [{ type: "text", delta: "hello" }] },
  );
  assert.deepEqual(
    parseResponsesEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 7 } },
    }),
    { events: [{ type: "usage", input: 12, output: 7 }] },
  );
});

test("parses Responses API errors", () => {
  assert.deepEqual(
    parseResponsesEvent({ type: "error", message: "bad request" }),
    { events: [], error: "bad request" },
  );
});

test("parses Chat Completions delta and usage", () => {
  assert.deepEqual(
    parseChatCompletionsEvent({
      choices: [{ delta: { content: "hello" } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }),
    {
      events: [
        { type: "text", delta: "hello" },
        { type: "usage", input: 9, output: 4 },
      ],
    },
  );
});

test("parses Anthropic Messages text and token events", () => {
  assert.deepEqual(
    parseAnthropicMessagesEvent({
      type: "content_block_delta",
      delta: { text: "hello" },
    }),
    { events: [{ type: "text", delta: "hello" }] },
  );
  assert.deepEqual(
    parseAnthropicMessagesEvent({
      type: "message_start",
      message: { usage: { input_tokens: 11 } },
    }),
    { events: [{ type: "usage", input: 11, output: 0 }] },
  );
  assert.deepEqual(
    parseAnthropicMessagesEvent({
      type: "message_delta",
      usage: { output_tokens: 6 },
    }),
    { events: [{ type: "usage", input: 0, output: 6 }] },
  );
});
