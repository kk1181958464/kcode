import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bundledRipgrepPath,
  nativeGlobFiles,
  nativeSearchCode,
} from "./workspace-search";

test("resolves a bundled ripgrep executable", () => {
  assert.match(bundledRipgrepPath(), /rg(?:\.exe)?$/i);
});

test("falls back to native glob and code search", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-search-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules", "ignored"), {
      recursive: true,
    });
    await writeFile(path.join(root, "src", "app.ts"), "const answer = 42;\n");
    await writeFile(path.join(root, "src", "app.css"), ".app {}\n");
    await writeFile(
      path.join(root, "node_modules", "ignored", "hidden.ts"),
      "const answer = 0;\n",
    );
    const signal = new AbortController().signal;
    assert.equal(await nativeGlobFiles(root, "**/*.ts", signal), "src/app.ts");
    assert.equal(
      await nativeSearchCode(root, "answer\\s*=\\s*42", "*.ts", signal),
      "src/app.ts:1:const answer = 42;",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
