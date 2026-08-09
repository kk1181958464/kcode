/**
 * File Read Deduplication — track content hashes of files that have been read
 * in the current session. When the model reads a file that hasn't changed since
 * its last read, return a short "unchanged" notice instead of the full content.
 *
 * Inspired by Claude Code's `type: "file_unchanged"` deduplication that saves
 * significant context tokens on repeated reads.
 */

import * as crypto from "node:crypto";

export interface ReadCacheEntry {
  /** SHA-256 hash of the file content at the time of read */
  contentHash: string;
  /** Timestamp of last read */
  lastReadAt: number;
  /** Number of times this file was read */
  readCount: number;
  /** The line range that was last requested (for partial read tracking) */
  lastRange?: { start: number; end: number };
}

/**
 * Tracks file reads within a session to detect unchanged re-reads.
 */
export class FileReadCache {
  private cache = new Map<string, ReadCacheEntry>();

  /**
   * Check if a file's content is unchanged since last read.
   * Returns the cached entry if content matches, null otherwise.
   */
  check(filePath: string, content: string, startLine?: number, endLine?: number): ReadCacheEntry | null {
    const entry = this.cache.get(filePath);
    if (!entry) return null;

    const hash = this.hash(content);
    if (hash !== entry.contentHash) return null;

    // If reading a different range, don't dedup (model may need different lines)
    if (startLine && endLine && entry.lastRange) {
      if (entry.lastRange.start !== startLine || entry.lastRange.end !== endLine) {
        return null;
      }
    }

    return entry;
  }

  /**
   * Record a file read. Call this after successfully returning content.
   */
  record(filePath: string, content: string, startLine?: number, endLine?: number): void {
    const existing = this.cache.get(filePath);
    this.cache.set(filePath, {
      contentHash: this.hash(content),
      lastReadAt: Date.now(),
      readCount: (existing?.readCount ?? 0) + 1,
      lastRange: startLine && endLine ? { start: startLine, end: endLine } : undefined,
    });
  }

  /**
   * Invalidate cache entry for a file (call when file is modified).
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Invalidate all entries matching a path prefix.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Check if a file has been read before (regardless of content change).
   */
  hasBeenRead(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  /**
   * Get all files that have been read this session.
   */
  getReadFiles(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get the hash recorded for a file (for stale detection).
   */
  getHash(filePath: string): string | undefined {
    return this.cache.get(filePath)?.contentHash;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  private hash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }
}

/** Generate the dedup notice shown to the model when file is unchanged. */
export function fileUnchangedNotice(filePath: string, readCount: number): string {
  return `[文件未变更] ${filePath} 内容与上次读取完全相同（已读取 ${readCount} 次）。如需查看完整内容请再次调用 read_file。`;
}
