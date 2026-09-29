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

test("keeps snapshots per workspace and run", async () => {
  const left = workspace("left");
  const right = workspace("right");
  const leftHistory = fileHistory(left.root, "run-left");
  const rightHistory = fileHistory(right.root, "run-right");
  assert.notEqual(leftHistory, rightHistory);
  assert.equal(fileHistory(left.root, "run-left"), leftHistory);

  assert.equal((await leftHistory.snapshot(left.file))?.version, 1);
  assert.equal((await rightHistory.snapshot(right.file))?.version, 1);
  fs.writeFileSync(left.file, "two");
  const second = await leftHistory.snapshot(left.file);
  assert.equal(second?.version, 2);
  assert.ok(second && fs.existsSync(second.snapshotPath));
  assert.deepEqual(rightHistory.getModifiedFiles(), [right.file]);

  releaseFileHistory("run-left");
  assert.notEqual(fileHistory(left.root, "run-left"), leftHistory);
  assert.equal(fileHistory(right.root, "run-right"), rightHistory);
  releaseFileHistory("run-left");
  releaseFileHistory("run-right");
});

test("undo restores snapshots in order and removes created files", async () => {
  const { root, file } = workspace("undo");
  const created = path.join(root, "new.txt");
  const history = fileHistory(root, "run-undo");

  // Queued without awaiting each: snapshots still apply in call order.
  await Promise.all([history.snapshot(file), history.snapshot(created)]);
  fs.writeFileSync(file, "two");
  fs.writeFileSync(created, "fresh");

  assert.equal((await history.undo(created)).success, true);
  assert.equal(fs.existsSync(created), false);
  const restored = await history.undo(file);
  assert.equal(restored.success, true);
  assert.equal(fs.readFileSync(file, "utf-8"), "one");
  assert.equal((await history.undo(file)).success, false);
  releaseFileHistory("run-undo");
});
