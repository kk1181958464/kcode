/**
 * TurnDiffTracker: Tracks actual file changes per tool call in a turn.
 * Provides ground-truth evidence of modifications, independent of model claims.
 *
 * For deterministic tools (write_file, apply_patch, delete_path, move_path),
 * captures before/after file snapshots. For run_command, records execution
 * metadata without file tracking (too unpredictable).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface FileDiff {
  path: string; // relative to workspace root
  action: "created" | "modified" | "deleted" | "moved";
  beforeHash?: string;
  afterHash?: string;
  additions?: number;
  deletions?: number;
}

export interface ToolCallDiff {
  tool: string;
  callId: string;
  timestamp: number;
  diffs: FileDiff[];
  /** For run_command: exit code if available */
  exitCode?: number;
}

export interface TurnDiffResult {
  turnIndex: number;
  toolCalls: ToolCallDiff[];
  /** All files that were actually changed this turn */
  changedFiles: string[];
  /** Whether any real file modification occurred */
  hasChanges: boolean;
}

interface FileSnapshot {
  path: string;
  hash: string | null; // null = file didn't exist
  lineCount: number;
}

/**
 * Predict which file paths a tool call will affect based on tool name and input.
 */
export function predictAffectedPaths(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  switch (toolName) {
    case "write_file": {
      const filePath = String(input.file_path ?? input.path ?? "");
      return filePath ? [resolvePath(root, filePath)] : [];
    }
    case "apply_patch": {
      const patch = String(input.patch ?? "");
      return extractPatchPaths(root, patch);
    }
    case "delete_path": {
      const target = String(input.path ?? "");
      return target ? [resolvePath(root, target)] : [];
    }
    case "move_path": {
      const source = String(input.source ?? "");
      const destination = String(input.destination ?? "");
      const paths: string[] = [];
      if (source) paths.push(resolvePath(root, source));
      if (destination) paths.push(resolvePath(root, destination));
      return paths;
    }
    default:
      return [];
  }
}

function resolvePath(root: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(root, filePath);
}

function extractPatchPaths(root: string, patch: string): string[] {
  const paths: string[] = [];
  const regex = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let match;
  while ((match = regex.exec(patch)) !== null) {
    paths.push(resolvePath(root, match[1]));
  }
  return paths;
}

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function snapshotFile(filePath: string): FileSnapshot {
  return {
    path: filePath,
    hash: hashFile(filePath),
    lineCount: countLines(filePath),
  };
}

export class TurnDiffTracker {
  private turnIndex = 0;
  private currentTurnCalls: ToolCallDiff[] = [];
  private preSnapshots: Map<string, FileSnapshot> = new Map();
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Update workspace root (e.g., when switching projects). */
  setRoot(root: string): void {
    this.root = root;
  }

  /**
   * Call BEFORE a tool executes. Snapshots files predicted to be affected.
   * Returns a snapshot key to use in afterTool().
   */
  beforeTool(
    toolName: string,
    callId: string,
    input: Record<string, unknown>,
  ): void {
    const paths = predictAffectedPaths(this.root, toolName, input);
    for (const p of paths) {
      if (!this.preSnapshots.has(p)) {
        this.preSnapshots.set(p, snapshotFile(p));
      }
    }
  }

  /**
   * Call AFTER a tool executes. Compares current state to pre-snapshot.
   */
  afterTool(
    toolName: string,
    callId: string,
    input: Record<string, unknown>,
    exitCode?: number,
  ): ToolCallDiff {
    const paths = predictAffectedPaths(this.root, toolName, input);
    const diffs: FileDiff[] = [];

    for (const p of paths) {
      const before = this.preSnapshots.get(p);
      const afterHash = hashFile(p);
      const afterLines = countLines(p);
      const relativePath = path.relative(this.root, p).replace(/\\/g, "/");

      if (!before || before.hash === null) {
        // File didn't exist before
        if (afterHash !== null) {
          diffs.push({
            path: relativePath,
            action: "created",
            afterHash,
            additions: afterLines,
          });
        }
      } else if (afterHash === null) {
        // File was deleted
        diffs.push({
          path: relativePath,
          action: "deleted",
          beforeHash: before.hash,
          deletions: before.lineCount,
        });
      } else if (before.hash !== afterHash) {
        // File was modified
        const additions = Math.max(0, afterLines - before.lineCount);
        const deletions = Math.max(0, before.lineCount - afterLines);
        diffs.push({
          path: relativePath,
          action: "modified",
          beforeHash: before.hash,
          afterHash,
          additions: additions || undefined,
          deletions: deletions || undefined,
        });
      }
      // If hashes match, no change — don't record
    }

    const result: ToolCallDiff = {
      tool: toolName,
      callId,
      timestamp: Date.now(),
      diffs,
      exitCode,
    };

    this.currentTurnCalls.push(result);
    return result;
  }

  /**
   * Finalize the current turn. Returns the diff result and resets state.
   */
  finalizeTurn(): TurnDiffResult {
    const allDiffs = this.currentTurnCalls.flatMap((tc) => tc.diffs);
    const changedFiles = [...new Set(allDiffs.map((d) => d.path))];

    const result: TurnDiffResult = {
      turnIndex: this.turnIndex,
      toolCalls: this.currentTurnCalls,
      changedFiles,
      hasChanges: changedFiles.length > 0,
    };

    // Reset for next turn
    this.turnIndex++;
    this.currentTurnCalls = [];
    this.preSnapshots.clear();

    return result;
  }

  /** Get current turn's changes without finalizing. */
  peek(): TurnDiffResult {
    const allDiffs = this.currentTurnCalls.flatMap((tc) => tc.diffs);
    const changedFiles = [...new Set(allDiffs.map((d) => d.path))];
    return {
      turnIndex: this.turnIndex,
      toolCalls: [...this.currentTurnCalls],
      changedFiles,
      hasChanges: changedFiles.length > 0,
    };
  }

  /** Check if any real changes occurred in the current turn so far. */
  hasCurrentChanges(): boolean {
    return this.currentTurnCalls.some((tc) => tc.diffs.length > 0);
  }

  /** Reset completely (e.g., new conversation). */
  reset(): void {
    this.turnIndex = 0;
    this.currentTurnCalls = [];
    this.preSnapshots.clear();
  }
}
