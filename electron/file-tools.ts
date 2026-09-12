import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const ignored = new Set([".git", "node_modules", "dist", "dist-electron", "release", "build", ".next", ".cache"]);
const workspacePath = (root: string, value: unknown) => {
  const target = path.resolve(root, String(value || "."));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("路径必须位于当前工作区内");
  return target;
};

export async function listDirectory(root: string, value: unknown, recursive: boolean) {
  const directory = workspacePath(root, value);
  const lines: string[] = [];
  const pending = [directory];
  while (pending.length && lines.length < 1_000) {
    const current = pending.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      lines.push(`${entry.isDirectory() ? "[dir] " : "[file]"} ${path.relative(directory, full)}`);
      if (lines.length >= 1_000) break;
      if (recursive && entry.isDirectory() && !ignored.has(entry.name)) pending.push(full);
    }
    if (!recursive) break;
  }
  return { path: path.relative(root, directory) || ".", output: lines.join("\n") || "目录为空" };
}

export async function readManyFiles(root: string, values: unknown) {
  const paths = Array.isArray(values) ? values.slice(0, 20) : [];
  if (!paths.length) throw new Error("缺少文件路径列表");
  const sections = await Promise.all(paths.map(async (item) => {
    const file = workspacePath(root, item);
    const content = await readFile(file, "utf8");
    return `===== ${path.relative(root, file)} =====\n${content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").slice(0, 40_000)}`;
  }));
  return { output: sections.join("\n\n").slice(0, 120_000) };
}

export async function pathInfo(root: string, value: unknown) {
  const target = workspacePath(root, value);
  const info = await stat(target);
  return { path: path.relative(root, target), output: JSON.stringify({ type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, createdAt: info.birthtime.toISOString(), modifiedAt: info.mtime.toISOString() }, null, 2) };
}

export async function makeDirectory(root: string, value: unknown) {
  const directory = workspacePath(root, value);
  let existed = false;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new Error("目标路径已存在且不是目录");
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  return { path: path.relative(root, directory), output: existed ? "目录已存在，未发生变更" : "目录已创建", changed: !existed };
}

export async function movePath(root: string, fromValue: unknown, toValue: unknown) {
  const from = workspacePath(root, fromValue);
  const to = workspacePath(root, toValue);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return { path: path.relative(root, to), output: `已从 ${path.relative(root, from)} 移动到 ${path.relative(root, to)}`, changed: true };
}

export async function deletePath(root: string, value: unknown, recursive: boolean) {
  const target = workspacePath(root, value);
  const info = await stat(target);
  await rm(target, { recursive: info.isDirectory() && recursive, force: false });
  return { path: path.relative(root, target), output: info.isDirectory() ? "目录已删除" : "文件已删除", changed: true };
}
