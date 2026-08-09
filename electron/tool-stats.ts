/**
 * Tool Stats Tracking — per-session metrics for tool usage.
 * Tracks invocation counts, success rates, timing, and file mutation stats.
 *
 * Inspired by Claude Code's internal telemetry that surfaces session
 * productivity metrics (files modified, lines changed, commands run).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolStats {
  /** Total tool calls made */
  totalCalls: number;
  /** Total successful calls */
  successCount: number;
  /** Total failed calls */
  failureCount: number;
  /** Calls by tool name */
  callsByTool: Record<string, number>;
  /** Success rate by tool name */
  successByTool: Record<string, number>;
  /** File read count */
  readCount: number;
  /** Unique files read */
  uniqueFilesRead: Set<string>;
  /** File write/patch count */
  writeCount: number;
  /** Unique files written */
  uniqueFilesWritten: Set<string>;
  /** Command execution count */
  commandCount: number;
  /** Lines added across all writes */
  linesAdded: number;
  /** Lines removed across all writes */
  linesRemoved: number;
  /** Total rounds (model turns) */
  roundCount: number;
  /** Total time spent in tool execution (ms) */
  totalToolTimeMs: number;
  /** Session start time */
  startedAt: number;
  /** Per-tool timing */
  timingByTool: Record<string, number>;
}

export interface ToolInvocation {
  toolName: string;
  callId: string;
  success: boolean;
  durationMs: number;
  input?: Record<string, unknown>;
  /** For file operations */
  filePath?: string;
  /** For patch/write operations */
  additions?: number;
  deletions?: number;
}

// ─── Tracker Class ──────────────────────────────────────────────────────────

/**
 * Tracks tool usage statistics for a single agent session.
 */
export class ToolStatsTracker {
  private stats: ToolStats = {
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    callsByTool: {},
    successByTool: {},
    readCount: 0,
    uniqueFilesRead: new Set(),
    writeCount: 0,
    uniqueFilesWritten: new Set(),
    commandCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    roundCount: 0,
    totalToolTimeMs: 0,
    startedAt: Date.now(),
    timingByTool: {},
  };

  /** Active call timers */
  private activeTimers = new Map<string, number>();

  /**
   * Mark the start of a tool invocation.
   */
  startCall(callId: string): void {
    this.activeTimers.set(callId, Date.now());
  }

  /**
   * Record a completed tool invocation.
   */
  recordCall(invocation: ToolInvocation): void {
    const { toolName, callId, success, durationMs, filePath, additions, deletions } =
      invocation;

    this.stats.totalCalls++;
    this.stats.callsByTool[toolName] = (this.stats.callsByTool[toolName] ?? 0) + 1;
    this.stats.totalToolTimeMs += durationMs;
    this.stats.timingByTool[toolName] =
      (this.stats.timingByTool[toolName] ?? 0) + durationMs;

    if (success) {
      this.stats.successCount++;
      this.stats.successByTool[toolName] =
        (this.stats.successByTool[toolName] ?? 0) + 1;
    } else {
      this.stats.failureCount++;
    }

    // Categorize by tool type
    if (isReadTool(toolName)) {
      this.stats.readCount++;
      if (filePath) this.stats.uniqueFilesRead.add(filePath);
    } else if (isWriteTool(toolName)) {
      this.stats.writeCount++;
      if (filePath) this.stats.uniqueFilesWritten.add(filePath);
      if (additions) this.stats.linesAdded += additions;
      if (deletions) this.stats.linesRemoved += deletions;
    } else if (isCommandTool(toolName)) {
      this.stats.commandCount++;
    }

    // Clean up timer
    this.activeTimers.delete(callId);
  }

  /**
   * Finish a call using the start timer.
   */
  finishCall(
    callId: string,
    toolName: string,
    success: boolean,
    opts?: { filePath?: string; additions?: number; deletions?: number },
  ): void {
    const startTime = this.activeTimers.get(callId);
    const durationMs = startTime ? Date.now() - startTime : 0;

    this.recordCall({
      toolName,
      callId,
      success,
      durationMs,
      filePath: opts?.filePath,
      additions: opts?.additions,
      deletions: opts?.deletions,
    });
  }

  /**
   * Increment the round counter.
   */
  incrementRound(): void {
    this.stats.roundCount++;
  }

  /**
   * Get a snapshot of current stats (serializable).
   */
  getSnapshot(): ToolStatsSnapshot {
    const elapsed = Date.now() - this.stats.startedAt;
    return {
      totalCalls: this.stats.totalCalls,
      successCount: this.stats.successCount,
      failureCount: this.stats.failureCount,
      successRate:
        this.stats.totalCalls > 0
          ? Math.round((this.stats.successCount / this.stats.totalCalls) * 100)
          : 100,
      callsByTool: { ...this.stats.callsByTool },
      readCount: this.stats.readCount,
      uniqueFilesRead: this.stats.uniqueFilesRead.size,
      writeCount: this.stats.writeCount,
      uniqueFilesWritten: this.stats.uniqueFilesWritten.size,
      commandCount: this.stats.commandCount,
      linesAdded: this.stats.linesAdded,
      linesRemoved: this.stats.linesRemoved,
      linesNet: this.stats.linesAdded - this.stats.linesRemoved,
      roundCount: this.stats.roundCount,
      totalToolTimeMs: this.stats.totalToolTimeMs,
      elapsedMs: elapsed,
      avgToolTimeMs:
        this.stats.totalCalls > 0
          ? Math.round(this.stats.totalToolTimeMs / this.stats.totalCalls)
          : 0,
      timingByTool: { ...this.stats.timingByTool },
    };
  }

  /**
   * Get a compact summary string suitable for display.
   */
  getSummary(): string {
    const s = this.getSnapshot();
    const parts: string[] = [];

    if (s.readCount) parts.push(`读取 ${s.readCount} 次 (${s.uniqueFilesRead} 文件)`);
    if (s.writeCount)
      parts.push(
        `写入 ${s.writeCount} 次 (${s.uniqueFilesWritten} 文件, +${s.linesAdded}/-${s.linesRemoved})`,
      );
    if (s.commandCount) parts.push(`命令 ${s.commandCount} 次`);
    if (s.roundCount) parts.push(`${s.roundCount} 轮`);
    if (s.totalCalls)
      parts.push(`成功率 ${s.successRate}%, 平均 ${s.avgToolTimeMs}ms/调用`);

    return parts.join(" | ") || "暂无工具调用";
  }

  /**
   * Reset all stats (for a new session).
   */
  reset(): void {
    this.stats = {
      totalCalls: 0,
      successCount: 0,
      failureCount: 0,
      callsByTool: {},
      successByTool: {},
      readCount: 0,
      uniqueFilesRead: new Set(),
      writeCount: 0,
      uniqueFilesWritten: new Set(),
      commandCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      roundCount: 0,
      totalToolTimeMs: 0,
      startedAt: Date.now(),
      timingByTool: {},
    };
    this.activeTimers.clear();
  }
}

// ─── Serializable Snapshot ──────────────────────────────────────────────────

export interface ToolStatsSnapshot {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  callsByTool: Record<string, number>;
  readCount: number;
  uniqueFilesRead: number;
  writeCount: number;
  uniqueFilesWritten: number;
  commandCount: number;
  linesAdded: number;
  linesRemoved: number;
  linesNet: number;
  roundCount: number;
  totalToolTimeMs: number;
  elapsedMs: number;
  avgToolTimeMs: number;
  timingByTool: Record<string, number>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isReadTool(name: string): boolean {
  return [
    "read_file",
    "read_many_files",
    "list_directory",
    "glob_files",
    "path_info",
    "search_code",
    "git_status",
    "git_diff",
    "git_log",
    "git_remote_status",
  ].includes(name);
}

function isWriteTool(name: string): boolean {
  return [
    "write_file",
    "apply_patch",
    "make_directory",
    "move_path",
    "delete_path",
  ].includes(name);
}

function isCommandTool(name: string): boolean {
  return ["run_command", "start_process", "ssh_run"].includes(name);
}

/** Module-level singleton tracker. */
let _tracker: ToolStatsTracker | null = null;

/**
 * Get the module-level stats tracker (creates one if needed).
 */
export function getToolStats(): ToolStatsTracker {
  if (!_tracker) {
    _tracker = new ToolStatsTracker();
  }
  return _tracker;
}

/**
 * Reset the module-level tracker (call at session start).
 */
export function resetToolStats(): ToolStatsTracker {
  _tracker = new ToolStatsTracker();
  return _tracker;
}
