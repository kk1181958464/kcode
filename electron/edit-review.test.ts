import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  keepPendingFiles,
  listEditCheckpoints,
  listPendingEdits,
  recordPendingEdit,
  resetEditReviewForTests,
  restoreEditCheckpoint,
  undoPendingFiles,
} from "./edit-review";

test("records first baseline per file and creates a turn checkpoint", async () => {
  resetEditReviewForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-edit-review-"));
  const file = path.join(root, "src", "a.ts");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "v1\n", "utf8");

  recordPendingEdit({
    root,
    requestId: "req-1",
    activityId: "act-1",
    file,
    before: "v1\n",
    existed: true,
  });
  recordPendingEdit({
    root,
    requestId: "req-1",
    activityId: "act-2",
    file,
    before: "v2\n",
    existed: true,
  });

  const pending = listPendingEdits("req-1", root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].before, "v1\n");
  assert.deepEqual(pending[0].activityIds, ["act-1", "act-2"]);

  const checkpoints = listEditCheckpoints("req-1");
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].label, "本轮改动前");
  assert.equal(checkpoints[0].fileCount, 1);
});

test("keep and undo pending files restore the turn baseline", async () => {
  resetEditReviewForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-edit-review-"));
  const file = path.join(root, "note.txt");
  await writeFile(file, "before\n", "utf8");
  recordPendingEdit({
    root,
    requestId: "req-2",
    activityId: "act-a",
    file,
    before: "before\n",
    existed: true,
  });
  await writeFile(file, "after\n", "utf8");

  const kept = await keepPendingFiles(root, "req-2", ["note.txt"]);
  assert.equal(kept.success, true);
  assert.deepEqual(kept.paths, ["note.txt"]);
  assert.equal(await readFile(file, "utf8"), "after\n");

  // Kept files are not undone unless forced.
  const blocked = await undoPendingFiles(root, "req-2", ["note.txt"]);
  assert.equal(blocked.success, false);

  const forced = await undoPendingFiles(root, "req-2", ["note.txt"], true);
  assert.equal(forced.success, true);
  assert.equal(await readFile(file, "utf8"), "before\n");
});

test("restore edit checkpoint rolls files back without clearing other state", async () => {
  resetEditReviewForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-edit-review-"));
  const created = path.join(root, "new.ts");
  const existing = path.join(root, "old.ts");
  await writeFile(existing, "old-before\n", "utf8");

  recordPendingEdit({
    root,
    requestId: "req-3",
    activityId: "act-old",
    file: existing,
    before: "old-before\n",
    existed: true,
  });
  recordPendingEdit({
    root,
    requestId: "req-3",
    activityId: "act-new",
    file: created,
    before: "",
    existed: false,
  });
  await writeFile(existing, "old-after\n", "utf8");
  await writeFile(created, "brand-new\n", "utf8");

  const checkpoints = listEditCheckpoints("req-3");
  assert.equal(checkpoints.length, 1);
  const result = await restoreEditCheckpoint(checkpoints[0].id);
  assert.equal(result.success, true);
  assert.equal(await readFile(existing, "utf8"), "old-before\n");
  await assert.rejects(() => readFile(created, "utf8"));
  assert.ok(result.activityIds.includes("act-old"));
  assert.ok(result.activityIds.includes("act-new"));
});
