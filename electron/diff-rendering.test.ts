import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDiffLine,
  DIFF_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeDiff,
} from "../src/diff-rendering";

test("classifies diff lines in display precedence order", () => {
  assert.equal(classifyDiffLine("+++ b/file.ts"), "meta");
  assert.equal(classifyDiffLine("--- a/file.ts"), "meta");
  assert.equal(classifyDiffLine("@@ -1 +1 @@"), "hunk");
  assert.equal(classifyDiffLine("+added"), "add");
  assert.equal(classifyDiffLine("-removed"), "del");
  assert.equal(classifyDiffLine(" index is content"), "context");
});

test("virtualizes only requested large diffs", () => {
  assert.equal(
    shouldVirtualizeDiff(DIFF_VIRTUALIZATION_THRESHOLD, true),
    false,
  );
  assert.equal(
    shouldVirtualizeDiff(DIFF_VIRTUALIZATION_THRESHOLD + 1, true),
    true,
  );
  assert.equal(shouldVirtualizeDiff(10_000, false), false);
});
