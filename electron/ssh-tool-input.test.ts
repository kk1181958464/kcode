import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  privateKeyForSshTool,
  userSuppliedSshPrivateKeyPath,
} from "./ssh-tool-input";

test("accepts an absolute SSH key path explicitly supplied by the user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kcode-ssh-key-"));
  const keyPath = path.join(directory, "id_ed25519");
  await writeFile(keyPath, "private-key-content", "utf8");
  const messages = [
    { role: "user" as const, content: `私钥：\"${keyPath}\"` },
  ];
  assert.equal(userSuppliedSshPrivateKeyPath(messages, keyPath), true);
  assert.equal(
    await privateKeyForSshTool({ privateKeyPath: keyPath }, messages),
    "private-key-content",
  );
  await rm(directory, { recursive: true, force: true });
});

test("rejects an SSH key path invented by the model", async () => {
  await assert.rejects(
    privateKeyForSshTool(
      { privateKeyPath: path.join(tmpdir(), "not-user-supplied") },
      [{ role: "user", content: "连接服务器" }],
    ),
    /必须由用户在对话中明确提供/,
  );
});

test("uses explicitly supplied SSH key content without reading a path", async () => {
  assert.equal(
    await privateKeyForSshTool(
      { privateKey: "inline-private-key" },
      [{ role: "user", content: "使用我提供的私钥" }],
    ),
    "inline-private-key",
  );
});
