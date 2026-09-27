import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownMessage,
  mayContainMath,
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

test("loads math plugins only for content that may contain math", () => {
  assert.equal(mayContainMath("plain **markdown** text"), false);
  assert.equal(mayContainMath("Energy is $E = mc^2$."), true);
  assert.equal(mayContainMath(String.raw`Inline \(x^2\) math`), true);
  assert.equal(mayContainMath(String.raw`Display \[x^2\] math`), true);
  assert.equal(mayContainMath(String.raw`path C:\Users\name`), false);
});

function referencePartition(src: string) {
  if (!src) return { sealedContent: "", sealedEnd: 0 };
  const lines = src.split("\n");
  let fence: string | null = null;
  let sealedEnd = 0;
  let cursor = 0;
  let hasContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const kind = marker[1][0];
      if (!fence) fence = kind;
      else if (fence === kind) fence = null;
      hasContent = true;
    } else if (!fence && line.trim() === "") {
      if (hasContent) {
        sealedEnd = cursor + lineLen;
        hasContent = false;
      } else if (sealedEnd > 0) sealedEnd = cursor + lineLen;
    } else hasContent = true;
    cursor += lineLen;
  }
  if (sealedEnd <= 0) return { sealedContent: "", sealedEnd: 0 };
  return { sealedContent: src.slice(0, sealedEnd), sealedEnd };
}

test("incremental streaming partition matches a full rescan", () => {
  const pieces = ["text", " more", "\n", "\n\n", "```ts", "~~~", "  ", "x = 1", "# h"];
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 300; round++) {
    let src = "";
    let sealedEnd = 0;
    for (let step = 0; step < 40; step++) {
      src += pieces[Math.floor(random() * pieces.length)];
      const full = partitionStreamingMarkdown(src);
      assert.deepEqual(full, referencePartition(src), JSON.stringify(src));
      // StreamingMarkdownTail never un-seals, so it keeps max(previous, full).
      const incremental = partitionStreamingMarkdown(src, sealedEnd);
      const expectedEnd = Math.max(sealedEnd, full.sealedEnd);
      assert.equal(incremental.sealedEnd, expectedEnd, JSON.stringify(src));
      assert.equal(incremental.sealedContent, src.slice(0, expectedEnd));
      sealedEnd = incremental.sealedEnd;
    }
  }
});
