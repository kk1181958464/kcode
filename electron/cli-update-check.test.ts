import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkForCliUpdate, compareVersions } from "../cli/update-check";

test("CLI update check compares stable and prerelease versions", () => {
  assert.equal(compareVersions("0.1.8", "0.1.7"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("CLI update check caches npm results and avoids repeated startup requests", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "kcode-update-check-"),
  );
  const cachePath = path.join(directory, "cache.json");
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ version: "0.1.8" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const first = await checkForCliUpdate({
      currentVersion: "0.1.7",
      cachePath,
      fetchImpl,
      now: 1_000,
    });
    assert.deepEqual(first, {
      currentVersion: "0.1.7",
      latestVersion: "0.1.8",
      installCommand: "npm install -g @kk1181958464/kcode@latest",
      source: "registry",
    });

    const second = await checkForCliUpdate({
      currentVersion: "0.1.7",
      cachePath,
      fetchImpl,
      now: 2_000,
    });
    assert.equal(second?.source, "cache");
    assert.equal(fetchCalls, 1);

    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      checkedVersion: string;
      latestVersion: string;
    };
    assert.equal(cache.checkedVersion, "0.1.7");
    assert.equal(cache.latestVersion, "0.1.8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI update check refreshes after the installed CLI version changes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "kcode-update-version-"),
  );
  const cachePath = path.join(directory, "cache.json");
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ version: "0.1.9" }), { status: 200 });
  };
  try {
    await checkForCliUpdate({
      currentVersion: "0.1.7",
      cachePath,
      fetchImpl,
      now: 1_000,
    });
    const result = await checkForCliUpdate({
      currentVersion: "0.1.8",
      cachePath,
      fetchImpl,
      now: 2_000,
    });
    assert.equal(result?.latestVersion, "0.1.9");
    assert.equal(fetchCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI update check times out silently and does not block startup", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "kcode-update-timeout-"),
  );
  const cachePath = path.join(directory, "cache.json");
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const keepAlive = setInterval(() => undefined, 10);
  try {
    const startedAt = Date.now();
    const result = await checkForCliUpdate({
      currentVersion: "0.1.7",
      cachePath,
      fetchImpl,
      timeoutMs: 25,
      now: 1_000,
    });
    assert.equal(result, null);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    clearInterval(keepAlive);
    await rm(directory, { recursive: true, force: true });
  }
});
