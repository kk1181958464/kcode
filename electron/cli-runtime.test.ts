import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveInitialPermissionMode } from "../cli/runtime-policy";
import { decryptCliSecret, encryptCliSecret } from "../cli/secure-storage";
import { sanitizeTerminalText } from "../cli/tui/ansi";
import { LiveView } from "../cli/tui/live-view";
import type { WriteSink } from "../cli/tui/renderer";

class Sink implements WriteSink {
  output = "";
  columns = 100;
  rows = 20;
  write(data: string): void {
    this.output += data;
  }
}

test("CLI keeps the complete assistant answer after committing terminal rows", () => {
  const sink = new Sink();
  const view = new LiveView(sink);
  view.push({ type: "text", delta: "first " });
  view.push({ type: "text", delta: "answer" });
  view.push({ type: "done", outcome: "completed" });
  assert.equal(view.answerText(), "first answer");
  view.dispose();
});

test("CLI terminal display strips model-supplied control sequences", () => {
  const value = "safe\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2J\rspoof";
  assert.equal(sanitizeTerminalText(value), "safe\nspoof");
  const sink = new Sink();
  const view = new LiveView(sink);
  view.push({ type: "text", delta: value });
  view.push({ type: "done", outcome: "completed" });
  assert.equal(view.answerText(), "safe\nspoof");
  assert.ok(!sink.output.includes("]52;"));
  assert.ok(!sink.output.includes("\x1b[2J\rspoof"));
  view.dispose();
});

test("non-interactive CLI is read-only unless full access is explicit", () => {
  assert.equal(
    resolveInitialPermissionMode({
      interactive: false,
      yolo: false,
      saved: "full-access",
    }),
    "read-only",
  );
  assert.equal(
    resolveInitialPermissionMode({ interactive: false, yolo: true }),
    "full-access",
  );
  assert.equal(
    resolveInitialPermissionMode({
      interactive: true,
      yolo: false,
      saved: "confirm",
    }),
    "confirm",
  );
});

test("CLI secrets use an authenticated encrypted envelope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kcode-cli-secret-"));
  const secret = "sk-test-not-plaintext";
  const encrypted = encryptCliSecret(secret, dir);
  assert.ok(!encrypted.toString("utf8").includes(secret));
  assert.equal(decryptCliSecret(encrypted, dir), secret);
  const key = await readFile(path.join(dir, "cli-storage.key"));
  assert.equal(key.length, 32);
  if (process.platform !== "win32") {
    const mode = (await stat(path.join(dir, "cli-storage.key"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const prefix = "kcode:aes-gcm:v1:";
  const payload = Buffer.from(
    encrypted.toString("utf8").slice(prefix.length),
    "base64",
  );
  payload[payload.length - 1] ^= 1;
  const tampered = Buffer.from(`${prefix}${payload.toString("base64")}`);
  assert.throws(() => decryptCliSecret(tampered, dir));
});
