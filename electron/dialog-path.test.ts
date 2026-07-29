import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { existingDirectory } from "./dialog-path";

test("uses an existing directory as a dialog default", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kcode-dialog-"));
  try {
    assert.equal(await existingDirectory(directory), path.resolve(directory));
    const file = path.join(directory, "context.txt");
    await writeFile(file, "context", "utf8");
    assert.equal(await existingDirectory(file), undefined);
    assert.equal(
      await existingDirectory(path.join(directory, "missing")),
      undefined,
    );
    assert.equal(await existingDirectory(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
