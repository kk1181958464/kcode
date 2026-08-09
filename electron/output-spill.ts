/**
 * Large Output Spill to Disk — when command output exceeds a threshold,
 * write it to a temporary file and return a compact summary (head + tail)
 * with a file reference, instead of inlining the full content in context.
 *
 * Inspired by Claude Code's approach that prevents large outputs from
 * consuming excessive context tokens.
 *
 * Threshold: outputs > 50KB get spilled.
 * Summary: first 2KB + last 2KB + metadata (total lines, byte size, path).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { app } from "electron";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Outputs larger than this get spilled to disk. */
export const SPILL_THRESHOLD_BYTES = 50_000; // 50KB

/** How much of head/tail to keep in the summary. */
const SUMMARY_HEAD_BYTES = 2_000;
const SUMMARY_TAIL_BYTES = 2_000;

/** Max age for spill files before cleanup. */
const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpillResult {
  /** Whether the output was spilled to disk */
  spilled: boolean;
  /** The summarized content to include in context */
  summary: string;
  /** Path to the full output file (only if spilled) */
  spillPath?: string;
  /** Original output size in bytes */
  originalSize: number;
  /** Total line count */
  lineCount: number;
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Process command output — spill to disk if too large, return compact summary.
 * If output is small enough, returns it unchanged.
 */
export function processLargeOutput(
  output: string,
  meta: {
    command?: string;
    toolName?: string;
    callId?: string;
    requestId?: string;
  } = {},
): SpillResult {
  const originalSize = Buffer.byteLength(output, "utf-8");
  const lineCount = countLines(output);

  // Below threshold — return as-is
  if (originalSize <= SPILL_THRESHOLD_BYTES) {
    return {
      spilled: false,
      summary: output,
      originalSize,
      lineCount,
    };
  }

  // Spill to disk
  const spillPath = writeSpillFile(output, meta);

  // Build compact summary
  const summary = buildSpillSummary(output, {
    spillPath,
    originalSize,
    lineCount,
    command: meta.command,
  });

  return {
    spilled: true,
    summary,
    spillPath,
    originalSize,
    lineCount,
  };
}

/**
 * Write the full output to a temporary spill file.
 */
function writeSpillFile(
  content: string,
  meta: { callId?: string; requestId?: string },
): string {
  const dir = spillDir();
  fs.mkdirSync(dir, { recursive: true });

  const hash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 12);
  const timestamp = Date.now();
  const filename = `${meta.requestId?.slice(0, 8) ?? "out"}_${hash}_${timestamp}.txt`;
  const filePath = path.join(dir, filename);

  try {
    fs.writeFileSync(filePath, content, "utf-8");
  } catch {
    // If write fails, return a fallback path
    return "(写入失败)";
  }

  return filePath;
}

/**
 * Build the compact summary: head + tail + metadata.
 */
function buildSpillSummary(
  output: string,
  info: {
    spillPath: string;
    originalSize: number;
    lineCount: number;
    command?: string;
  },
): string {
  const head = output.slice(0, SUMMARY_HEAD_BYTES);
  const tail = output.slice(-SUMMARY_TAIL_BYTES);

  const omittedBytes = info.originalSize - SUMMARY_HEAD_BYTES - SUMMARY_TAIL_BYTES;
  const omittedLines = Math.max(
    0,
    info.lineCount - countLines(head) - countLines(tail),
  );

  const parts: string[] = [];

  // Header with metadata
  parts.push(
    `[输出过大已溢出到磁盘] 共 ${info.lineCount} 行, ${formatBytes(info.originalSize)}`,
  );
  if (info.command) {
    parts.push(`命令: ${info.command.slice(0, 200)}`);
  }
  parts.push(`完整输出: ${info.spillPath}`);
  parts.push("");

  // Head section
  parts.push("--- 输出开头 ---");
  parts.push(head);

  // Omission notice
  if (omittedBytes > 0) {
    parts.push(
      `\n... [省略 ${omittedLines} 行, ${formatBytes(omittedBytes)}] ...\n`,
    );
  }

  // Tail section
  parts.push("--- 输出结尾 ---");
  parts.push(tail);

  return parts.join("\n");
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Remove old spill files that have exceeded the max age.
 * Call periodically (e.g., at session start) to prevent disk bloat.
 */
export function cleanupSpillFiles(maxAgeMs = SPILL_MAX_AGE_MS): number {
  const dir = spillDir();
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Dir read failed
  }

  return removed;
}

/**
 * Read a spill file by path (for when model needs full content).
 */
export function readSpillFile(spillPath: string): string | null {
  try {
    if (!spillPath.startsWith(spillDir())) {
      // Security: only read from our spill directory
      return null;
    }
    return fs.readFileSync(spillPath, "utf-8");
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function spillDir(): string {
  return path.join(app.getPath("userData"), "output-spill");
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
