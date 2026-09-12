import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReadCache } from "./file-read-cache";

export type FileWriteSnapshot = { file: string; before: string; after: string; existed: boolean };
export type FileDiff = { diff?: string; additions?: number; deletions?: number };
export type FileWriteOptions = { cache: FileReadCache; onSnapshot: (snapshot: FileWriteSnapshot) => void; diff: (file: string, before: string, after: string) => FileDiff };

function resolve(root: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少文件路径");
  return path.resolve(root, value);
}

export async function readFileTool(root: string, input: Record<string, unknown>, cache: FileReadCache) {
  const file = resolve(root, input.path);
  const content = (await readFile(file, "utf8")).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = content.split("\n");
  const start = Math.max(1, Number(input.startLine) || 1);
  const end = Math.min(lines.length, Number(input.endLine) || start + 399);
  const full = start === 1 && end >= lines.length;
  const relative = path.relative(root, file);
  if (full && cache.check(file, content)) return { output: `[文件未变化] ${relative} 内容与上次读取完全相同，无需重复展示。`, path: relative };
  if (full) cache.record(file, content);
  return { output: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n").slice(0, 80_000), path: relative };
}

export async function writeFileTool(root: string, input: Record<string, unknown>, options: FileWriteOptions) {
  const file = resolve(root, input.path);
  const content = String(input.content ?? "");
  let before = ""; let existed = true;
  try { before = await readFile(file, "utf8"); } catch { existed = false; }
  await mkdir(path.dirname(file), { recursive: true });
  const changed = !existed || before !== content;
  if (changed) {
    await writeFile(file, content, "utf8");
    options.cache.invalidate(file);
    options.onSnapshot({ file, before, after: content, existed });
  }
  return { output: changed ? `已写入 ${Buffer.byteLength(content)} 字节` : "文件内容一致，未发生实际修改", changed, path: path.relative(root, file), undoable: changed, ...options.diff(path.relative(root, file).replaceAll("\\", "/"), before, content) };
}
