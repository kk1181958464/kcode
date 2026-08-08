import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelRequest } from "../src/types";

const MAX_PRIVATE_KEY_BYTES = 2_000_000;

export function userSuppliedSshPrivateKeyPath(
  messages: ModelRequest["messages"],
  candidate: string,
) {
  const value = candidate.trim();
  if (!value || !path.isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, "/").toLocaleLowerCase();
  return messages.some((message) => {
    if (message.role !== "user") return false;
    const content = message.content.toLocaleLowerCase();
    return (
      content.includes(value.toLocaleLowerCase()) ||
      content.replace(/\\/g, "/").includes(normalized)
    );
  });
}

export async function privateKeyForSshTool(
  input: Record<string, unknown>,
  messages: ModelRequest["messages"],
) {
  if (typeof input.privateKey === "string" && input.privateKey.trim())
    return input.privateKey;
  if (
    typeof input.privateKeyPath !== "string" ||
    !input.privateKeyPath.trim()
  )
    return undefined;

  const privateKeyPath = input.privateKeyPath.trim();
  if (!userSuppliedSshPrivateKeyPath(messages, privateKeyPath))
    throw new Error(
      "SSH 私钥路径必须是绝对路径，并且必须由用户在对话中明确提供。",
    );
  const info = await stat(privateKeyPath).catch(() => undefined);
  if (!info?.isFile()) throw new Error("用户提供的 SSH 私钥文件不存在。");
  if (info.size > MAX_PRIVATE_KEY_BYTES)
    throw new Error("SSH 私钥文件超过 2 MB，已拒绝读取。");
  return readFile(privateKeyPath, "utf8");
}
