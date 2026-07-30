import assert from "node:assert/strict";
import test from "node:test";
import { extractGitFileDiff } from "../src/git-diff";

test("extracts one file from a multi-file git diff", () => {
  const diff = [
    "diff --git a/src/App.tsx b/src/App.tsx",
    "--- a/src/App.tsx",
    "+++ b/src/App.tsx",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/styles.css b/src/styles.css",
    "--- a/src/styles.css",
    "+++ b/src/styles.css",
    "@@ -2 +2 @@",
    "-old-style",
    "+new-style",
  ].join("\n");

  assert.match(extractGitFileDiff(diff, "src/styles.css"), /new-style/);
  assert.doesNotMatch(extractGitFileDiff(diff, "src/styles.css"), /new\n/);
});

test("matches absolute Windows activity paths to relative git paths", () => {
  const diff = [
    "diff --git a/src/App.tsx b/src/App.tsx",
    "--- a/src/App.tsx",
    "+++ b/src/App.tsx",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  assert.match(
    extractGitFileDiff(diff, "D:\\project\\kcode\\src\\App.tsx"),
    /src\/App\.tsx/,
  );
});
