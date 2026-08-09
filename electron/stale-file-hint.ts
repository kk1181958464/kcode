/**
 * Stale File Hints — after a shell command executes, detect which previously-read
 * files have been modified on disk. Inject a hint into context so the model knows
 * to re-read before making assumptions about file content.
 *
 * Inspired by Claude Code's stale-file detection that prevents the model from
 * operating on outdated mental models of file content.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { FileReadCache } from "./file-read-cache";

export interface StaleFileResult {
  /** Files that changed since last read */
  staleFiles: string[];
  /** Files that were deleted since last read */
  deletedFiles: string[];
  /** Total number of previously-read files checked */
  checkedCount: number;
}

/**
 * Check all previously-read files against their current disk content.
 * Returns which files have become stale (modified or deleted externally).
 */
export function detectStaleFiles(cache: FileReadCache): StaleFileResult {
  const readFiles = cache.getReadFiles();
  const staleFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const filePath of readFiles) {
    const cachedHash = cache.getHash(filePath);
    if (!cachedHash) continue;

    try {
      const currentContent = fs.readFileSync(filePath, "utf-8");
      const currentHash = crypto
        .createHash("sha256")
        .update(currentContent)
        .digest("hex");

      if (currentHash !== cachedHash) {
        staleFiles.push(filePath);
        // Invalidate so next read gets fresh content
        cache.invalidate(filePath);
      }
    } catch {
      // File no longer readable (deleted or permissions changed)
      deletedFiles.push(filePath);
      cache.invalidate(filePath);
    }
  }

  return { staleFiles, deletedFiles, checkedCount: readFiles.length };
}

/**
 * Format a stale file hint for injection into context.
 * Returns empty string if no files are stale.
 */
export function formatStaleFileHint(result: StaleFileResult): string {
  if (result.staleFiles.length === 0 && result.deletedFiles.length === 0) {
    return "";
  }

  const parts: string[] = [];

  if (result.staleFiles.length > 0) {
    const fileList = result.staleFiles
      .map((f) => `  - ${f}`)
      .join("\n");
    parts.push(
      `以下文件在命令执行后已被修改，缓存内容已过期，请在操作前重新读取：\n${fileList}`,
    );
  }

  if (result.deletedFiles.length > 0) {
    const fileList = result.deletedFiles
      .map((f) => `  - ${f}`)
      .join("\n");
    parts.push(`以下文件已被删除或不可读：\n${fileList}`);
  }

  return `<stale_file_hint>\n${parts.join("\n\n")}\n</stale_file_hint>`;
}

/**
 * Convenience: detect + format in one call.
 * Returns empty string if nothing is stale.
 */
export function getStaleFileHint(cache: FileReadCache): string {
  const result = detectStaleFiles(cache);
  return formatStaleFileHint(result);
}
