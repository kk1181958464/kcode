import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

const ignoredDirectories = new Set([".git", "node_modules"]);
const MAX_FILES = 50_000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;

export function bundledRipgrepPath() {
  const arch = process.env.npm_config_arch || process.arch;
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const resolved = require.resolve(
      `@vscode/ripgrep-${process.platform}-${arch}/bin/${binary}`,
    );
    return resolved.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  } catch {
    return "rg";
  }
}

async function workspaceFiles(root: string, signal: AbortSignal) {
  const files: string[] = [];
  const pending = [root];
  while (pending.length && files.length < MAX_FILES) {
    if (signal.aborted) throw new Error("任务已取消");
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (signal.aborted) throw new Error("任务已取消");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(absolute);
      } else if (entry.isFile()) files.push(absolute);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

const relativeFile = (root: string, file: string) =>
  path.relative(root, file).replaceAll("\\", "/");

export async function nativeGlobFiles(
  root: string,
  pattern: string,
  signal: AbortSignal,
) {
  const files = await workspaceFiles(root, signal);
  return files
    .map((file) => relativeFile(root, file))
    .filter((file) =>
      minimatch(file, pattern, {
        dot: true,
        matchBase: true,
        nocase: process.platform === "win32",
      }),
    )
    .slice(0, 1_000)
    .join("\n");
}

export async function nativeSearchCode(
  root: string,
  query: string,
  glob: string | undefined,
  signal: AbortSignal,
) {
  let expression: RegExp;
  try {
    expression = new RegExp(query);
  } catch (error) {
    throw new Error(
      `搜索表达式无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = await workspaceFiles(root, signal);
  const matches: string[] = [];
  for (const file of files) {
    if (signal.aborted) throw new Error("任务已取消");
    const relative = relativeFile(root, file);
    if (
      glob &&
      !minimatch(relative, glob, {
        dot: true,
        matchBase: true,
        nocase: process.platform === "win32",
      })
    )
      continue;
    try {
      if ((await stat(file)).size > MAX_SEARCH_FILE_BYTES) continue;
      const content = await readFile(file, "utf8");
      if (content.includes("\0")) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (expression.test(line))
          matches.push(`${relative}:${index + 1}:${line}`);
        if (matches.length >= MAX_SEARCH_MATCHES) return matches.join("\n");
      }
    } catch {
      // Files can disappear or become unreadable while a workspace is scanned.
    }
  }
  return matches.join("\n");
}
