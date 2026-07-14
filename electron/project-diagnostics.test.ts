import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProjectDiagnostic } from "./project-diagnostics";

test("uses an existing type-check script alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-diagnostics-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { "check:types": "tsc --noEmit", build: "vite build" },
      }),
    );
    assert.deepEqual(await resolveProjectDiagnostic(root, "typecheck"), {
      script: "check:types",
      command: "npm run check:types",
      available: ["build", "check:types"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips a missing diagnostic instead of running a nonexistent script", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-diagnostics-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { build: "vite build" } }),
    );
    const result = await resolveProjectDiagnostic(root, "typecheck");
    assert.equal(result.script, undefined);
    assert.match(result.message ?? "", /未配置 typecheck 脚本，已跳过/);
    assert.deepEqual(result.available, ["build"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
