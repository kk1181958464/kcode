/**
 * Hook Lifecycle System — configurable event-driven hooks loaded from
 * `.kcode/hooks.json`. Supports script (external command) and prompt
 * (context injection) handlers for lifecycle events.
 *
 * Inspired by Claude Code's hooks system: PreToolUse, PostToolUse,
 * Stop, Notification, SessionStart events with script execution.
 *
 * Configuration file: `.kcode/hooks.json`
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "type": "command", "command": "node .kcode/validate-patch.js", "matcher": "apply_patch" },
 *       { "type": "prompt", "content": "Always verify...", "matcher": "*" }
 *     ],
 *     "PostToolUse": [...],
 *     "Stop": [...],
 *     "SessionStart": [...]
 *   }
 * }
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "Notification";

export type HookHandlerType = "command" | "prompt";

export interface HookHandler {
  /** Handler type */
  type: HookHandlerType;
  /** For "command": shell command to execute */
  command?: string;
  /** For "prompt": text to inject into context */
  content?: string;
  /** Tool name pattern to match (* = all). Only relevant for Pre/PostToolUse. */
  matcher?: string;
  /** Timeout in ms for command execution (default: 10000) */
  timeout?: number;
  /** Whether hook failure should block the operation (default: false) */
  blocking?: boolean;
}

export interface HookConfig {
  hooks: Partial<Record<HookEvent, HookHandler[]>>;
}

export interface HookExecutionResult {
  /** Whether the hook allowed the action to proceed */
  allowed: boolean;
  /** Any output from command execution */
  output?: string;
  /** Any text to inject into context */
  inject?: string;
  /** Error message if hook failed */
  error?: string;
  /** Which handler produced this result */
  handler: HookHandler;
}

// ─── Configuration Loading ───────────────────────────────────────────────────

const HOOKS_FILENAME = "hooks.json";
const HOOKS_DIR = ".kcode";
const DEFAULT_TIMEOUT = 10_000;
const MAX_OUTPUT_LENGTH = 4_000;

let cachedConfig: {
  config: HookConfig | null;
  loadedAt: number;
  root: string;
} | null = null;
const CONFIG_TTL_MS = 30_000;

/**
 * Load hook configuration from `.kcode/hooks.json`.
 * Returns null if no config exists or is invalid.
 */
export function loadHookConfig(workspaceRoot: string): HookConfig | null {
  const now = Date.now();
  if (
    cachedConfig &&
    cachedConfig.root === workspaceRoot &&
    now - cachedConfig.loadedAt < CONFIG_TTL_MS
  ) {
    return cachedConfig.config;
  }

  // Cache misses too: this runs before every tool call, and most workspaces
  // have no hooks.json.
  const config = readHookConfig(workspaceRoot);
  cachedConfig = { config, root: workspaceRoot, loadedAt: now };
  return config;
}

function readHookConfig(workspaceRoot: string): HookConfig | null {
  const configPath = path.join(workspaceRoot, HOOKS_DIR, HOOKS_FILENAME);
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as HookConfig;

    // Basic validation
    if (!parsed.hooks || typeof parsed.hooks !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Invalidate the cached hook config (e.g., after user edits hooks.json).
 */
export function invalidateHookConfig(): void {
  cachedConfig = null;
}

// ─── Hook Execution ──────────────────────────────────────────────────────────

export interface HookContext {
  /** Current workspace root */
  workspaceRoot: string;
  /** Tool name (for Pre/PostToolUse) */
  toolName?: string;
  /** Tool input (for Pre/PostToolUse) */
  toolInput?: Record<string, unknown>;
  /** Tool result (for PostToolUse) */
  toolResult?: { success: boolean; output?: string };
  /** Model response text (for Stop) */
  responseText?: string;
  /** Session/request ID */
  requestId?: string;
  /** Cancellation shared with the owning agent run. */
  signal?: AbortSignal;
  /** Environment variables to pass to commands */
  env?: Record<string, string>;
}

/**
 * Run all hooks for a given event. Returns combined results.
 */
export async function runHooks(
  event: HookEvent,
  context: HookContext,
): Promise<HookExecutionResult[]> {
  context.signal?.throwIfAborted();
  const config = loadHookConfig(context.workspaceRoot);
  if (!config) return [];

  const handlers = config.hooks[event];
  if (!handlers || !handlers.length) return [];

  const results: HookExecutionResult[] = [];

  for (const handler of handlers) {
    context.signal?.throwIfAborted();
    // Check matcher for tool-specific hooks
    if (
      (event === "PreToolUse" || event === "PostToolUse") &&
      handler.matcher &&
      handler.matcher !== "*"
    ) {
      if (!matchesToolPattern(handler.matcher, context.toolName)) {
        continue;
      }
    }

    const result = await executeHandler(handler, event, context);
    // Cancellation stops the run even when the hook is non-blocking.
    context.signal?.throwIfAborted();
    results.push(result);

    // If blocking hook rejects, stop processing further hooks
    if (handler.blocking && !result.allowed) {
      break;
    }
  }

  return results;
}

/**
 * Execute a single hook handler.
 */
async function executeHandler(
  handler: HookHandler,
  event: HookEvent,
  context: HookContext,
): Promise<HookExecutionResult> {
  if (handler.type === "prompt") {
    return {
      allowed: true,
      inject: handler.content || undefined,
      handler,
    };
  }

  if (handler.type === "command") {
    return executeCommandHandler(handler, event, context);
  }

  return { allowed: true, handler };
}

interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Run a shell command without blocking the main process. Never rejects.
 */
function runCommand(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    env: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        ...options,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024, // 1MB
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolve({ exitCode, stdout, stderr, error });
      },
    );
  });
}

/**
 * Execute a command-type hook handler.
 * The command receives context via environment variables.
 */
async function executeCommandHandler(
  handler: HookHandler,
  event: HookEvent,
  context: HookContext,
): Promise<HookExecutionResult> {
  if (!handler.command) {
    return { allowed: true, handler, error: "No command specified" };
  }

  const timeout = handler.timeout ?? DEFAULT_TIMEOUT;

  // Build environment with hook context
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    KCODE_HOOK_EVENT: event,
    KCODE_WORKSPACE: context.workspaceRoot,
    ...(context.toolName && { KCODE_TOOL_NAME: context.toolName }),
    ...(context.requestId && { KCODE_REQUEST_ID: context.requestId }),
    ...(context.toolInput && {
      KCODE_TOOL_INPUT: JSON.stringify(context.toolInput),
    }),
    ...(context.toolResult && {
      KCODE_TOOL_RESULT: JSON.stringify(context.toolResult),
    }),
    ...(context.responseText && {
      KCODE_RESPONSE_TEXT: context.responseText.slice(0, 2000),
    }),
    ...(context.env || {}),
  };

  const result = await runCommand(handler.command, {
    cwd: context.workspaceRoot,
    timeout,
    env,
    signal: context.signal,
  });

  if (result.error) {
    // Non-zero exit (or timeout) = hook rejects (for blocking hooks)
    const allowed = !handler.blocking || result.exitCode === 0;
    const output = result.stderr
      ? result.stderr.slice(0, MAX_OUTPUT_LENGTH)
      : undefined;
    return { allowed, output, error: result.error.message, handler };
  }

  const trimmedOutput = result.stdout.trim().slice(0, MAX_OUTPUT_LENGTH);

  // Parse structured output if JSON
  let inject: string | undefined;
  let allowed = true;
  try {
    const parsed = JSON.parse(trimmedOutput);
    if (typeof parsed === "object" && parsed !== null) {
      allowed = parsed.allowed !== false;
      inject = parsed.inject || parsed.message || undefined;
    }
  } catch {
    // Not JSON — treat as plain text injection
    if (trimmedOutput) inject = trimmedOutput;
  }

  return { allowed, output: trimmedOutput, inject, handler };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Match a tool pattern against a tool name.
 * Supports simple glob: "apply_*" matches "apply_patch", "apply_diff", etc.
 */
function matchesToolPattern(
  pattern: string,
  toolName: string | undefined,
): boolean {
  if (!toolName) return false;
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Simple glob: only supports trailing wildcard
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  // Comma-separated list
  if (pattern.includes(",")) {
    return pattern.split(",").some((p) => p.trim() === toolName);
  }

  return false;
}

/**
 * Aggregate injected prompts from hook results.
 */
export function collectInjections(results: HookExecutionResult[]): string {
  const injections = results
    .filter((r) => r.inject)
    .map((r) => r.inject!)
    .join("\n");
  return injections
    ? `<hook_output>\n${injections}\n</hook_output>`
    : "";
}

/**
 * Check if any blocking hook rejected the action.
 */
export function isBlocked(results: HookExecutionResult[]): boolean {
  return results.some((r) => !r.allowed && r.handler.blocking);
}

/**
 * Get the rejection message from a blocked hook.
 */
export function getBlockReason(results: HookExecutionResult[]): string {
  const blocked = results.find((r) => !r.allowed && r.handler.blocking);
  if (!blocked) return "";
  return (
    blocked.output ||
    blocked.error ||
    "Hook rejected the operation"
  );
}
