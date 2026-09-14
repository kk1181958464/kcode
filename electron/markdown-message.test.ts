import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownMessage,
  closeOpenMarkdownFence,
  isOpenMarkdownFence,
  partitionStreamingMarkdown,
} from "../src/components/common/MarkdownMessage";

Object.assign(globalThis, { React });

test("renders generated local files as resource-manager links", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownMessage, {
      content: "[面试题及答案](reports/%E9%9D%A2%E8%AF%95%E9%A2%98.txt)",
      workspacePath: "D:/project/kcode",
    }),
  );
  assert.match(markup, /class="local-file-link"/);
  assert.match(markup, /title="在文件资源管理器中显示"/);
  assert.doesNotMatch(markup, /target="_blank"/);
});

test("keeps web links external", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownMessage, {
      content: "[文档](https://example.com/docs)",
      workspacePath: "D:/project/kcode",
    }),
  );
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noreferrer"/);
  assert.doesNotMatch(markup, /local-file-link/);
});

test("isOpenMarkdownFence detects dangling code fences", () => {
  assert.equal(isOpenMarkdownFence("```python\nprint(1)\n"), true);
  assert.equal(isOpenMarkdownFence("```python\nprint(1)\n```\n"), false);
  assert.equal(isOpenMarkdownFence("plain text"), false);
});

test("closeOpenMarkdownFence bounds a split timeline segment", () => {
  const open = "```python\nrouter = APIRouter()\n";
  const closed = closeOpenMarkdownFence(open);
  assert.equal(isOpenMarkdownFence(open), true);
  assert.equal(isOpenMarkdownFence(closed), false);
  assert.match(closed, /```\s*$/);
  assert.equal(
    closeOpenMarkdownFence("already ```ok``` done"),
    "already ```ok``` done",
  );
});

test("partitionStreamingMarkdown keeps open fence out of sealed content", () => {
  const src = "hello\n\n```python\nprint(1)\n";
  const part = partitionStreamingMarkdown(src);
  assert.ok(part.sealedEnd > 0);
  assert.match(part.sealedContent, /hello/);
  assert.equal(isOpenMarkdownFence(src.slice(part.sealedEnd)), true);
});
