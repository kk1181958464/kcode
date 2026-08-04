import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveRevealPath } from "./reveal-path";
import { localPathFromMarkdownHref } from "../src/lib/reveal-path";

test("resolves relative and encoded generated files from the workspace", () => {
  const root = path.resolve("D:/project/kcode");
  assert.equal(
    resolveRevealPath("reports/%E7%AD%94%E6%A1%88.txt", root),
    path.resolve(root, "reports/答案.txt"),
  );
});

test("recognizes local markdown links without hijacking web links", () => {
  assert.equal(
    localPathFromMarkdownHref("outputs/result.txt"),
    "outputs/result.txt",
  );
  assert.equal(
    localPathFromMarkdownHref("D:/downloads/result.txt"),
    "D:/downloads/result.txt",
  );
  assert.equal(
    localPathFromMarkdownHref("file:///D:/downloads/result.txt"),
    "file:///D:/downloads/result.txt",
  );
  assert.equal(
    localPathFromMarkdownHref("https://example.com/result.txt"),
    undefined,
  );
  assert.equal(localPathFromMarkdownHref("mailto:user@example.com"), undefined);
  assert.equal(localPathFromMarkdownHref("#result"), undefined);
});

test("resolves file URLs to local files", () => {
  const target = resolveRevealPath(
    "file:///D:/downloads/report%20final.txt",
    "D:/project/kcode",
  );
  assert.equal(target, path.resolve("D:/downloads/report final.txt"));
});

test("rejects non-file URI schemes in the main process", () => {
  assert.throws(
    () => resolveRevealPath("https://example.com/file.txt", "D:/project/kcode"),
    /只支持本地文件路径/,
  );
});
