/**
 * Parallel Tool Dispatch — classify and group tool calls for concurrent
 * execution when safe. Read-only tools targeting different files can run
 * in parallel without ordering constraints.
 *
 * Inspired by Claude Code's parallel tool dispatch that significantly
 * reduces round-trip latency for multi-file reads.
 *
 * Strategy:
 * - Read-only tools (read_file, list_directory, glob_files, search_code,
 *   path_info, read_many_files, git_status, git_log, git_diff) → parallelizable
 * - Write tools (write_file, apply_patch, delete_path, move_path) → sequential
 * - Commands (run_command, start_process) → sequential (side effects)
 * - Mixed batches → split into parallel reads + sequential writes
 */

export type ToolCategory = "readonly" | "write" | "command" | "interactive";

/**
 * Tools that are safe to execute in parallel (no side effects).
 */
const READONLY_TOOLS = new Set([
  "read_file",
  "read_many_files",
  "list_directory",
  "glob_files",
  "path_info",
  "search_code",
  "git_status",
  "git_remote_status",
  "git_diff",
  "git_log",
  "get_context_remaining",
]);

/**
 * Tools that mutate files — must run sequentially.
 */
const WRITE_TOOLS = new Set([
  "apply_patch",
  "write_file",
  "make_directory",
  "move_path",
  "delete_path",
]);

/**
 * Tools that execute commands — must run sequentially.
 */
const COMMAND_TOOLS = new Set([
  "run_command",
  "start_process",
  "stop_process",
  "ssh_run",
  "ssh_write_file",
  "ssh_upload_file",
  "ssh_download_file",
]);

/**
 * Tools requiring user interaction — must run sequentially.
 */
const INTERACTIVE_TOOLS = new Set([
  "request_user_input",
  "report_no_change",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_snapshot",
]);

/**
 * Classify a tool by its execution safety category.
 */
export function classifyTool(toolName: string): ToolCategory {
  if (READONLY_TOOLS.has(toolName)) return "readonly";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (COMMAND_TOOLS.has(toolName)) return "command";
  if (INTERACTIVE_TOOLS.has(toolName)) return "interactive";
  // Unknown tools default to sequential for safety
  return "command";
}

/**
 * A group of tool calls that can be executed together.
 */
export interface DispatchGroup {
  /** Whether all tools in this group can run concurrently */
  parallel: boolean;
  /** The tool calls in this group */
  calls: Array<{ id: string; name: string; input: unknown }>;
}

/**
 * Partition tool calls into dispatch groups.
 * Consecutive readonly calls are grouped for parallel execution.
 * All other calls form single-item sequential groups.
 *
 * Example: [read, read, write, read, read] →
 *   [{parallel: true, calls: [read, read]},
 *    {parallel: false, calls: [write]},
 *    {parallel: true, calls: [read, read]}]
 */
export function partitionForDispatch(
  calls: Array<{ id: string; name: string; input: unknown }>,
): DispatchGroup[] {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    return [{ parallel: false, calls }];
  }

  const groups: DispatchGroup[] = [];
  let currentReadonly: typeof calls = [];

  for (const call of calls) {
    const category = classifyTool(call.name);
    if (category === "readonly") {
      currentReadonly.push(call);
    } else {
      // Flush any accumulated readonly calls as a parallel group
      if (currentReadonly.length > 0) {
        groups.push({
          parallel: currentReadonly.length > 1,
          calls: currentReadonly,
        });
        currentReadonly = [];
      }
      // Non-readonly tools get their own sequential group
      groups.push({ parallel: false, calls: [call] });
    }
  }

  // Flush remaining readonly calls
  if (currentReadonly.length > 0) {
    groups.push({
      parallel: currentReadonly.length > 1,
      calls: currentReadonly,
    });
  }

  return groups;
}

/**
 * Check if a set of calls can all run in parallel.
 */
export function canParallelize(
  calls: Array<{ name: string; input: unknown }>,
): boolean {
  if (calls.length <= 1) return false;

  // All must be readonly
  if (!calls.every((c) => classifyTool(c.name) === "readonly")) return false;

  // Check for overlapping file targets (e.g., two reads of same file are fine,
  // but we allow it since reads are idempotent)
  return true;
}

/**
 * Maximum concurrency for parallel dispatch.
 * Prevents overwhelming the filesystem with too many concurrent operations.
 */
export const MAX_PARALLEL_CONCURRENCY = 8;

/**
 * Execute a batch of async operations with bounded concurrency.
 */
export async function parallelWithLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit = MAX_PARALLEL_CONCURRENCY,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }

  // Spawn `limit` workers
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    runNext(),
  );
  await Promise.all(workers);
  return results;
}
