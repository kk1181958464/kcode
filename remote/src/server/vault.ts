import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function dataKey(raw: string | undefined) {
  if (!raw) throw new Error("KCODE_DATA_KEY 未配置");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error("KCODE_DATA_KEY 必须是 32 字节 Base64 密钥");
  return key;
}

export function encryptJson(value: unknown, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptJson<T>(value: string, key: Buffer): T {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext)
    throw new Error("云端配置格式无效");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
