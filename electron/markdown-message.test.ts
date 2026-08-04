import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "../src/components/common/MarkdownMessage";

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
