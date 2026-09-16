import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileReadCache } from "./file-read-cache";
import { applyUpdatePatch } from "./text-patch";

type Action = "Update" | "Add" | "Delete";
export type PatchChange = { action: Action; file: string; before: string; after: string; existed: boolean };
export type PatchOptions = { cache: FileReadCache; diff: (file: string, before: string, after: string) => { diff?: string; additions: number; deletions: number }; onUndo: (change: PatchChange) => void; onPending?: (change: PatchChange) => void };
function resolve(root: string, value: string) { const file = path.resolve(root, value); if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("路径必须位于当前工作区内"); return file; }
export async function applyPatchTool(root: string, patchText: string, options: PatchOptions) {
  const lines = patchText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") throw new Error("补丁必须以 *** Begin Patch 开始");
  const changes: PatchChange[] = [];
  for (let index = 1; index < lines.length;) {
    const header = lines[index++]; if (header === "*** End Patch") break;
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(header);
    if (!match) { if (!header.trim()) continue; throw new Error(`无法识别的补丁段：${header}`); }
    const action = match[1] as Action; const relative = match[2]; const file = resolve(root, relative); const body: string[] = [];
    while (index < lines.length && !lines[index].startsWith("*** ")) body.push(lines[index++]);
    let before = ""; let existed = true; try { before = await readFile(file, "utf8"); } catch { existed = false; }
    if (action !== "Add" && !existed) throw new Error(`文件不存在：${relative}`);
    const after = action === "Delete" ? "" : action === "Add" ? body.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n") : applyUpdatePatch(before, body);
    changes.push({ action, file, before, after, existed });
  }
  if (!changes.length) throw new Error("补丁中没有文件变更");
  const actual = changes.filter((change) => change.action === "Delete" || !change.existed || change.before !== change.after);
  for (const change of actual) {
    if (change.action === "Delete") await unlink(change.file); else { await mkdir(path.dirname(change.file), { recursive: true }); await writeFile(change.file, change.after, "utf8"); }
    options.cache.invalidate(change.file);
    options.onPending?.(change);
  }
  if (actual.length === 1 && actual[0].action !== "Delete") options.onUndo(actual[0]);
  const diffs = actual.map((change) => ({ path: path.relative(root, change.file).replaceAll("\\", "/"), ...options.diff(path.relative(root, change.file).replaceAll("\\", "/"), change.before, change.after) }));
  return { output: actual.length ? `已应用补丁，修改 ${actual.length} 个文件` : "补丁内容与现有文件一致，未发生实际修改", changed: actual.length > 0, path: changes.length === 1 ? path.relative(root, changes[0].file) : `${changes.length} 个文件`, diff: diffs.map((item) => item.diff).join("\n\n"), additions: diffs.reduce((sum, item) => sum + item.additions, 0), deletions: diffs.reduce((sum, item) => sum + item.deletions, 0), fileChanges: diffs, undoable: actual.length === 1 && actual[0].action !== "Delete" };
}
