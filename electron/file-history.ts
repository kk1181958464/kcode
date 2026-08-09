/**
 * File History Snapshots — save file state before every mutation so users
 * can undo any change made by the agent. Snapshots are stored per-session
 * in a flat directory with content-addressable naming.
 *
 * Inspired by Claude Code's file-history system that enables one-click rollback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { app } from "electron";

export interface FileSnapshot {
  /** Absolute path to the original file */
  filePath: string;
  /** Version number (increments per file per session) */
  version: number;
  /** Timestamp when snapshot was taken */
  timestamp: number;
  /** Path to the stored snapshot content */
  snapshotPath: string;
  /** SHA-256 hash of the content (for dedup) */
  contentHash: string;
  /** Size in bytes */
  size: number;
  /** Whether the file existed before (false = file was newly created) */
  existed: boolean;
}

export interface UndoResult {
  success: boolean;
  filePath: string;
  restoredVersion: number;
  message: string;
}

/**
 * Manages file snapshots for a single session.
 */
export class FileHistoryManager {
  private sessionDir: string;
  private snapshots: Map<string, FileSnapshot[]> = new Map();
  private initialized = false;

  constructor(
    private sessionId: string,
    private workspaceRoot: string,
  ) {
    this.sessionDir = path.join(
      app.getPath("userData"),
      "file-history",
      sessionId,
    );
  }

  /** Ensure the storage directory exists. */
  private ensureDir(): void {
    if (this.initialized) return;
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      this.initialized = true;
    } catch {
      // Best effort — non-critical feature
    }
  }

  /**
   * Take a snapshot of a file before it's modified.
   * Returns the snapshot metadata, or null if the file doesn't exist (new file creation).
   */
  snapshot(filePath: string): FileSnapshot | null {
    this.ensureDir();

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);

    // Check if file exists
    let content: Buffer;
    let existed = true;
    try {
      content = fs.readFileSync(absolutePath);
    } catch {
      // File doesn't exist yet — record that it was newly created
      existed = false;
      const versions = this.snapshots.get(absolutePath) || [];
      const snapshot: FileSnapshot = {
        filePath: absolutePath,
        version: versions.length + 1,
        timestamp: Date.now(),
        snapshotPath: "", // No content to store
        contentHash: "",
        size: 0,
        existed: false,
      };
      versions.push(snapshot);
      this.snapshots.set(absolutePath, versions);
      return snapshot;
    }

    // Compute hash for dedup
    const contentHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");

    // Check if we already have this exact content saved
    const versions = this.snapshots.get(absolutePath) || [];
    const lastSnapshot = versions[versions.length - 1];
    if (lastSnapshot && lastSnapshot.contentHash === contentHash) {
      // Content unchanged since last snapshot — skip
      return lastSnapshot;
    }

    // Store the snapshot
    const version = versions.length + 1;
    const snapshotFilename = `${contentHash.slice(0, 12)}@v${version}`;
    const snapshotPath = path.join(this.sessionDir, snapshotFilename);

    try {
      fs.writeFileSync(snapshotPath, content);
    } catch {
      return null; // Storage failed — non-critical
    }

    const snapshot: FileSnapshot = {
      filePath: absolutePath,
      version,
      timestamp: Date.now(),
      snapshotPath,
      contentHash,
      size: content.length,
      existed,
    };

    versions.push(snapshot);
    this.snapshots.set(absolutePath, versions);

    return snapshot;
  }

  /**
   * Undo the last modification to a file.
   * Restores from the most recent snapshot.
   */
  undo(filePath: string): UndoResult {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);

    const versions = this.snapshots.get(absolutePath);
    if (!versions || versions.length === 0) {
      return {
        success: false,
        filePath: absolutePath,
        restoredVersion: 0,
        message: "没有该文件的历史快照",
      };
    }

    const lastSnapshot = versions[versions.length - 1];

    // If file was newly created (didn't exist before), delete it
    if (!lastSnapshot.existed) {
      try {
        fs.unlinkSync(absolutePath);
        versions.pop();
        return {
          success: true,
          filePath: absolutePath,
          restoredVersion: lastSnapshot.version - 1,
          message: "文件已删除（还原到创建前状态）",
        };
      } catch (err) {
        return {
          success: false,
          filePath: absolutePath,
          restoredVersion: lastSnapshot.version,
          message: `还原失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Restore from snapshot
    try {
      const content = fs.readFileSync(lastSnapshot.snapshotPath);
      fs.writeFileSync(absolutePath, content);
      versions.pop();
      return {
        success: true,
        filePath: absolutePath,
        restoredVersion: lastSnapshot.version,
        message: `已还原到版本 ${lastSnapshot.version}`,
      };
    } catch (err) {
      return {
        success: false,
        filePath: absolutePath,
        restoredVersion: lastSnapshot.version,
        message: `还原失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get the history of snapshots for a file.
   */
  getHistory(filePath: string): FileSnapshot[] {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    return this.snapshots.get(absolutePath) || [];
  }

  /**
   * Get all files that have been modified this session.
   */
  getModifiedFiles(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /**
   * Get total number of snapshots stored.
   */
  get snapshotCount(): number {
    let count = 0;
    for (const versions of this.snapshots.values()) {
      count += versions.length;
    }
    return count;
  }

  /**
   * Clean up old session data.
   * Removes snapshot directories older than maxAge.
   */
  static cleanup(maxAgeDays = 30): void {
    const historyRoot = path.join(app.getPath("userData"), "file-history");
    try {
      const sessions = fs.readdirSync(historyRoot);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const session of sessions) {
        const sessionPath = path.join(historyRoot, session);
        try {
          const stat = fs.statSync(sessionPath);
          if (stat.isDirectory() && stat.mtimeMs < cutoff) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    } catch {
      // History root doesn't exist yet — nothing to clean
    }
  }
}

/** Singleton instance — lazily initialized per workspace. */
let _instance: FileHistoryManager | null = null;

export function fileHistory(workspaceRoot: string, sessionId?: string): FileHistoryManager {
  if (!_instance || _instance["workspaceRoot"] !== workspaceRoot) {
    _instance = new FileHistoryManager(workspaceRoot, sessionId || "default");
  }
  return _instance;
}
