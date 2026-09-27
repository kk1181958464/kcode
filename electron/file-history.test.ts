import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileHistory, releaseFileHistory } from "./file-history";

function workspace(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kcode-fh-${name}-`));
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "one");
  return { root, file };
}

test("keeps snapshots per workspace and run", () => {
  const left = workspace("left");
  const right = workspace("right");
  const leftHistory = fileHistory(left.root, "run-left");
  const rightHistory = fileHistory(right.root, "run-right");
  assert.notEqual(leftHistory, rightHistory);
  assert.equal(fileHistory(left.root, "run-left"), leftHistory);

  assert.equal(leftHistory.snapshot(left.file)?.version, 1);
  assert.equal(rightHistory.snapshot(right.file)?.version, 1);
  fs.writeFileSync(left.file, "two");
  const second = leftHistory.snapshot(left.file);
  assert.equal(second?.version, 2);
  assert.ok(second && fs.existsSync(second.snapshotPath));
  assert.deepEqual(rightHistory.getModifiedFiles(), [right.file]);

  releaseFileHistory("run-left");
  assert.notEqual(fileHistory(left.root, "run-left"), leftHistory);
  assert.equal(fileHistory(right.root, "run-right"), rightHistory);
  releaseFileHistory("run-left");
  releaseFileHistory("run-right");
});
