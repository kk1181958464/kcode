import assert from "node:assert/strict";
import test from "node:test";
import { countTextLines, parseGitNumstat } from "./git-workspace-state";

test("parses per-file Git numstat including renamed and binary files", () => {
  assert.deepEqual(
    parseGitNumstat(
      [
        "12\t3\tsrc/app.ts\0",
        "-\t-\tassets/icon.png\0",
        "5\t2\t\0old.ts\0src/new.ts\0",
      ].join(""),
    ),
    [
      { path: "src/app.ts", additions: 12, deletions: 3 },
      { path: "assets/icon.png", additions: 0, deletions: 0 },
      { path: "src/new.ts", additions: 5, deletions: 2 },
    ],
  );
});

test("counts untracked text lines and rejects binary contents", () => {
  assert.equal(countTextLines(Buffer.from("one\r\ntwo\n")), 2);
  assert.equal(countTextLines(Buffer.from("one")), 1);
  assert.equal(countTextLines(Buffer.alloc(0)), 0);
  assert.equal(countTextLines(Buffer.from([1, 0, 2])), undefined);
});
