import test from "node:test";
import assert from "node:assert/strict";
import { applyUpdatePatch, normalizeLineEndings } from "./text-patch";

test("applies an LF patch to a CRLF PHP file without changing its line endings", () => {
  const original = [
    "<?php",
    "$columns = ['id', 'name'];",
    "return $columns;",
    "",
  ].join("\r\n");

  const updated = applyUpdatePatch(original, [
    "@@",
    " <?php",
    "-$columns = ['id', 'name'];",
    "+$columns = ['id', 'name', 'status'];",
    " return $columns;",
  ]);

  assert.equal(
    updated,
    [
      "<?php",
      "$columns = ['id', 'name', 'status'];",
      "return $columns;",
      "",
    ].join("\r\n"),
  );
  assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
});

test("preserves a UTF-8 BOM while patching CRLF content", () => {
  const original = "\uFEFFfirst\r\nsecond\r\n";
  const updated = applyUpdatePatch(original, [
    "@@",
    " first",
    "-second",
    "+changed",
  ]);

  assert.equal(updated, "\uFEFFfirst\r\nchanged\r\n");
});

test("normalizes CRLF and legacy CR patch input", () => {
  assert.equal(
    normalizeLineEndings("*** Begin Patch\r\nline\rnext"),
    "*** Begin Patch\nline\nnext",
  );
});
