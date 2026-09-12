/** Split a unified / git patch into per-file hunk groups for git-diff-view. */

export type UnifiedDiffFile = {
  oldPath: string;
  newPath: string;
  hunks: string[];
};

function cleanPath(raw: string) {
  let path = raw.trim();
  // drop optional timestamp after tab
  const tab = path.indexOf("\t");
  if (tab >= 0) path = path.slice(0, tab).trim();
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1);
  return path;
}

/**
 * Parse one or more file sections out of a unified diff string.
 * Returns an empty array when the text does not look like a patch.
 */
export function parseUnifiedDiffFiles(text: string): UnifiedDiffFile[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const files: UnifiedDiffFile[] = [];
  let oldPath = "";
  let newPath = "";
  let hunkLines: string[] = [];
  let hunks: string[] = [];

  const flushHunk = () => {
    if (!hunkLines.length) return;
    hunks.push(hunkLines.join("\n"));
    hunkLines = [];
  };

  const flushFile = () => {
    flushHunk();
    if (!hunks.length) {
      oldPath = "";
      newPath = "";
      return;
    }
    files.push({
      oldPath: oldPath || newPath || "file",
      newPath: newPath || oldPath || "file",
      hunks,
    });
    oldPath = "";
    newPath = "";
    hunks = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      continue;
    }
    if (line.startsWith("--- ")) {
      if (hunks.length || hunkLines.length) flushFile();
      oldPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      hunkLines = [line];
      continue;
    }
    if (hunkLines.length) {
      hunkLines.push(line);
      continue;
    }
  }
  flushFile();
  return files;
}

export function displayDiffPath(file: UnifiedDiffFile) {
  const path = file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
}

/**
 * @git-diff-view requires ---/+++ headers inside the hunk strings,
 * otherwise it builds zero lines (blank / black viewer).
 */
export function toDiffViewHunks(file: UnifiedDiffFile): string[] {
  if (!file.hunks.length) return [];
  const oldHeader =
    file.oldPath === "/dev/null" ? "--- /dev/null" : `--- a/${file.oldPath}`;
  const newHeader =
    file.newPath === "/dev/null" ? "+++ /dev/null" : `+++ b/${file.newPath}`;
  // One combined patch string keeps every @@ hunk; headers on the first
  // hunk alone would drop later sections.
  return [`${oldHeader}\n${newHeader}\n${file.hunks.join("\n")}`];
}
