import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillStore, type SkillStoreFetch } from "./skill-store";

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  const bytes = Buffer.from(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return {
    ok,
    status,
    json: async () => JSON.parse(bytes.toString("utf8")),
    arrayBuffer: async () => bytes,
  };
}

async function fixture(fetchImpl: SkillStoreFetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kcode-skill-store-"));
  const bundledSkillsRoot = path.join(root, "bundled");
  const userSkillsRoot = path.join(root, "user");
  const stateFile = path.join(root, "state", "skills.json");
  const bundledRegistryPath = path.join(root, "registry.json");
  await mkdir(path.join(bundledSkillsRoot, "built-in"), { recursive: true });
  await writeFile(
    path.join(bundledSkillsRoot, "built-in", "SKILL.md"),
    "built in",
  );
  const store = createSkillStore({
    bundledSkillsRoot,
    userSkillsRoot,
    stateFile,
    bundledRegistryPath,
    fetchImpl,
  });
  return { root, store, userSkillsRoot, stateFile, bundledRegistryPath };
}

test("rejects path traversal and absolute registry file paths", async () => {
  for (const invalidPath of [
    "../outside",
    "folder/../outside",
    "/absolute",
    "C:\\absolute",
  ]) {
    const registry = {
      skills: [
        {
          id: "bad",
          files: [{ path: invalidPath, url: "https://files/skill" }],
        },
      ],
    };
    const context = await fixture(async (url) =>
      response(url === "https://files/skill" ? "bad" : registry),
    );
    try {
      await assert.rejects(
        context.store.install("bad"),
        /Invalid skill file path/,
      );
      await assert.rejects(access(path.join(context.root, "outside")));
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  }
});

test("installs declared files only after SKILL.md and sha256 validation", async () => {
  const markdown = "---\nname: sample\n---\nDo work.\n";
  const digest = createHash("sha256").update(markdown).digest("hex");
  const registry = {
    skills: [
      {
        id: "sample",
        name: "Sample",
        version: "1.2.0",
        files: [
          { path: "SKILL.md", url: "https://files/skill", sha256: digest },
          { path: "refs/info.txt", url: "https://files/info" },
        ],
      },
    ],
  };
  const context = await fixture(async (url) => {
    if (url === "https://files/skill") return response(markdown);
    if (url === "https://files/info") return response("reference");
    return response(registry);
  });
  try {
    const installed = await context.store.install("sample");
    assert.equal(installed.installed, true);
    assert.equal(installed.version, "1.2.0");
    assert.equal(
      await readFile(
        path.join(context.userSkillsRoot, "sample", "refs", "info.txt"),
        "utf8",
      ),
      "reference",
    );

    const bad = await fixture(async (url) =>
      response(
        url.includes("raw.githubusercontent")
          ? {
              skills: [
                {
                  id: "bad-hash",
                  files: [
                    {
                      path: "SKILL.md",
                      url: "https://files/skill",
                      sha256: "0".repeat(64),
                    },
                  ],
                },
              ],
            }
          : "content",
      ),
    );
    try {
      await assert.rejects(bad.store.install("bad-hash"), /sha256 mismatch/);
      await assert.rejects(access(path.join(bad.userSkillsRoot, "bad-hash")));
    } finally {
      await rm(bad.root, { recursive: true, force: true });
    }
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("persists enable state and uninstalls user skills without removing bundled skills", async () => {
  const registry = {
    skills: [
      {
        id: "sample",
        files: [{ path: "SKILL.md", url: "https://files/skill" }],
      },
    ],
  };
  const context = await fixture(async (url) =>
    response(url === "https://files/skill" ? "skill" : registry),
  );
  try {
    await context.store.install("sample");
    assert.equal((await context.store.disable("sample")).enabled, false);
    assert.equal(
      JSON.parse(await readFile(context.stateFile, "utf8")).enabled.sample,
      false,
    );
    assert.equal((await context.store.enable("sample")).enabled, true);
    await context.store.uninstall("sample");
    await assert.rejects(access(path.join(context.userSkillsRoot, "sample")));
    await assert.rejects(
      context.store.uninstall("built-in"),
      /User-installed skill not found/,
    );
    await access(path.join(context.root, "bundled", "built-in", "SKILL.md"));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("imports a local skill directory into the user skill root", async () => {
  const context = await fixture(async () => response({ skills: [] }));
  const source = path.join(context.root, "local-skill");
  await mkdir(path.join(source, "references"), { recursive: true });
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: local-skill\ndescription: Local test skill\n---\nUse it.\n",
  );
  await writeFile(path.join(source, "references", "guide.md"), "guide");
  try {
    const imported = await context.store.importDirectory(source);
    assert.equal(imported.id, "local-skill");
    assert.equal(imported.installed, true);
    assert.equal(imported.enabled, true);
    assert.equal(
      await readFile(
        path.join(context.userSkillsRoot, "local-skill", "references", "guide.md"),
        "utf8",
      ),
      "guide",
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("falls back to bundled registry when remote fetch fails and refresh clears cache", async () => {
  let calls = 0;
  const context = await fixture(async () => {
    calls += 1;
    return response({}, false, 503);
  });
  try {
    await writeFile(
      context.bundledRegistryPath,
      JSON.stringify({
        skills: [{ id: "fallback", name: "Fallback", files: [] }],
      }),
    );
    assert.deepEqual(
      (await context.store.list(true)).map((skill) => skill.id),
      ["built-in", "fallback"],
    );
    await context.store.list(true);
    assert.equal(calls, 1);
    context.store.refresh();
    await context.store.list(true);
    assert.equal(calls, 2);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("shows bundled skills without waiting for the remote registry", async () => {
  let remoteResolved = false;
  const context = await fixture(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          remoteResolved = true;
          resolve(response({ skills: [] }));
        }, 100);
      }),
  );
  try {
    await writeFile(
      context.bundledRegistryPath,
      JSON.stringify({ skills: [{ id: "built-in", files: [] }] }),
    );
    const local = await context.store.list();
    assert.equal(remoteResolved, false);
    assert.deepEqual(
      local.map((skill) => skill.id),
      ["built-in"],
    );
    assert.deepEqual(
      (await context.store.list(true)).map((skill) => skill.id),
      ["built-in"],
    );
    assert.equal(remoteResolved, true);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
