import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollaborationPicker } from "../src/components/composer/CollaborationPicker";
import type { ProviderConfig } from "../src/types";

Object.assign(globalThis, { React });

const providers: ProviderConfig[] = [
  {
    id: "planner",
    name: "Planner",
    baseUrl: "https://planner.test",
    protocol: "openai-responses",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "sol",
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        protocol: "openai-responses",
      },
    ],
  },
  {
    id: "executor",
    name: "Executor",
    baseUrl: "https://executor.test",
    protocol: "openai-chat",
    enabled: true,
    hasApiKey: true,
    models: [
      {
        id: "luna",
        modelId: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        protocol: "openai-chat",
        reasoningEfforts: ["auto", "low", "medium", "high"],
      },
    ],
  },
];

test("composer shows the configured execution model", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CollaborationPicker, {
      providers,
      plannerSelection: "planner|sol",
      value: {
        mode: "planner-executor",
        executorModelSelection: "executor|luna",
        executorReasoningEffort: "high",
      },
      onChange() {},
    }),
  );

  assert.match(markup, /GPT-5\.6 Luna/);
  assert.match(markup, /aria-label="执行 · GPT-5\.6 Luna · 高"/);
  assert.match(markup, /规划：当前模型 · 执行：GPT-5\.6 Luna/);
});

test("composer keeps single-model mode explicit", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CollaborationPicker, {
      providers,
      plannerSelection: "planner|sol",
      onChange() {},
    }),
  );
  assert.match(markup, /单模型/);
  assert.match(markup, /多模型协作/);
});
