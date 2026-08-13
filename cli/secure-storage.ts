import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "kcode:aes-gcm:v1:";

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows ACLs are managed by the OS; chmod is best-effort there.
  }
}

export function loadOrCreateStorageKey(stateDir: string): Buffer {
  ensurePrivateDirectory(stateDir);
  const keyPath = path.join(stateDir, "cli-storage.key");
  try {
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32)
      throw new Error("CLI storage key has an invalid length");
    return key;
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ))
      throw error;
    const key = randomBytes(32);
    try {
      fs.writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if (
        writeError instanceof Error &&
        "code" in writeError &&
        (writeError as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        const existing = fs.readFileSync(keyPath);
        if (existing.length !== 32)
          throw new Error("CLI storage key has an invalid length");
        return existing;
      }
      throw writeError;
    }
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort on Windows.
    }
    return key;
  }
}

export function encryptCliSecret(plain: string, stateDir: string): Buffer {
  const key = loadOrCreateStorageKey(stateDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`,
  );
}

export function decryptCliSecret(value: Buffer, stateDir: string): string {
  const encoded = value.toString("utf8");
  if (!encoded.startsWith(PREFIX)) {
    // Migrate provider files written by CLI versions that only base64-encoded
    // plaintext. The next save writes the encrypted envelope.
    return value.toString("utf8");
  }
  const payload = Buffer.from(encoded.slice(PREFIX.length), "base64");
  if (payload.length < 29) throw new Error("CLI encrypted secret is truncated");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    loadOrCreateStorageKey(stateDir),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
