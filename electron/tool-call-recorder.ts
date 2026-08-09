/**
 * ExecutedToolCallRecorder — builds a compact execution summary for each turn.
 * Injected into the next model context to reduce hallucinated action claims.
 *
 * Format: [Turn N] tool(arg) ✓/✗ (details). Modified: file (+lines/-lines).
 * Target: < 200 tokens per turn summary.
 */

import type { TurnDiffResult, ToolCallDiff } from "./turn-diff-tracker";

export interface ToolCallRecord {
  toolName: string;
  callId: string;
  /** Primary argument (file path, command, etc.) */
  primaryArg: string;
  success: boolean;
  /** Exit code for commands, undefined for file tools */
  exitCode?: number;
  /** Duration in ms */
  durationMs?: number;
  /** Error summary if failed */
  error?: string;
}

/**
 * Build a concise turn execution summary suitable for injection into model context.
 * Stays under ~200 tokens to avoid context bloat.
 */
export function buildTurnSummary(
  turnIndex: number,
  records: ToolCallRecord[],
  turnDiff?: TurnDiffResult,
): string {
  if (!records.length) return "";

  const parts: string[] = [`[Turn ${turnIndex}]`];

  for (const record of records) {
    const status = record.success ? "✓" : "✗";
    const arg = truncate(record.primaryArg, 60);
    let detail = "";
    if (record.exitCode !== undefined && record.exitCode !== 0) {
      detail = ` (exit ${record.exitCode})`;
    } else if (record.error) {
      detail = ` (${truncate(record.error, 40)})`;
    }
    parts.push(`${record.toolName}(${arg}) ${status}${detail}`);
  }

  // Append actual file changes from TurnDiffTracker
  if (turnDiff && turnDiff.hasChanges) {
    const fileChanges = turnDiff.toolCalls
      .flatMap((tc: ToolCallDiff) => tc.diffs)
      .filter((d) => d.action === "created" || d.action === "modified" || d.action === "deleted" || d.action === "moved")
      .map((d) => {
        const adds = d.additions ? `+${d.additions}` : "";
        const dels = d.deletions ? `-${d.deletions}` : "";
        const stats = [adds, dels].filter(Boolean).join("/");
        return `${d.path}(${stats || d.action})`;
      })
      .slice(0, 8); // Limit to 8 files max to keep under token budget

    if (fileChanges.length > 0) {
      parts.push(`Modified: ${fileChanges.join(", ")}`);
    }
  }

  return parts.join(" ");
}

/**
 * Extract the primary argument from a tool call's input for display.
 */
export function extractPrimaryArg(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "apply_patch":
      // Extract file paths from patch text
      const patch = String(input.patch ?? "");
      const files = [...patch.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)]
        .map((m) => m[1])
        .slice(0, 3);
      return files.join(", ") || "patch";

    case "write_file":
      return String(input.file_path ?? input.path ?? "");

    case "read_file":
      return String(input.file_path ?? input.path ?? "");

    case "run_command":
    case "ssh_run":
      return String(input.command ?? "").slice(0, 80);

    case "start_process":
      return String(input.command ?? "").slice(0, 80);

    case "delete_path":
      return String(input.path ?? "");

    case "move_path":
      return `${input.source ?? ""} → ${input.destination ?? ""}`;

    case "search_code":
      return String(input.query ?? input.pattern ?? "");

    case "list_directory":
      return String(input.path ?? ".");

    case "browser_open":
      return String(input.url ?? "");

    case "browser_click":
      return String(input.selector ?? input.ref ?? "");

    case "spawn_agent":
      return truncate(String(input.task ?? ""), 60);

    default:
      // Try common field names
      return truncate(
        String(
          input.path ?? input.file_path ?? input.command ?? input.query ?? "",
        ),
        60,
      );
  }
}

/**
 * Format the execution record into the XML-wrapped context block.
 */
export function formatTurnRecord(summary: string): string {
  if (!summary) return "";
  return `<tool_execution_record>\n${summary}\n</tool_execution_record>`;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + "…";
}
