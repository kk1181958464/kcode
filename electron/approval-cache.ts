import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  evaluateCommandPolicy,
  tokenizeShellCommand,
  type CommandPolicyAction,
  type CommandPolicyRule,
} from "../src/permissions";
import { canonicalizeCommand, extractCommandSignature } from "./command-canonicalize";

export type ApprovalScope = "once" | "session" | "permanent";

export interface ApprovalEntry {
  pattern: string[];
  scope: "session" | "permanent";
  category: string;
  workspace?: string;
  createdAt: number;
}

/**
 * Commands that must NEVER be auto-approved regardless of cached rules.
 * These are destructive or security-sensitive operations.
 */
const DENYLIST_PATTERNS: string[][] = [
  ["rm", "-rf"],
  ["rm", "-r"],
  ["rmdir", "/s"],
  ["del", "/s"],
  ["format"],
  ["git", "push", "--force"],
  ["git", "push", "-f"],
  ["git", "reset", "--hard"],
  ["git", "clean", "-f"],
  ["DROP", "TABLE"],
  ["DROP", "DATABASE"],
  ["TRUNCATE"],
  ["shutdown"],
  ["reboot"],
  ["mkfs"],
];

function isDenylisted(command: string): boolean {
  const segments = tokenizeShellCommand(command);
  return DENYLIST_PATTERNS.some((pattern) =>
    segments.some((segment) =>
      pattern.every(
        (token, index) =>
          segment[index]?.toLowerCase() === token.toLowerCase(),
      ),
    ),
  );
}

/**
 * Generalize a concrete command into a reusable pattern.
 * Canonicalizes the command first (normalize whitespace, paths, quotes),
 * then keeps the executable + subcommand (first 2 tokens), wildcards the rest.
 * e.g. "npm run build" → ["npm", "run"]
 *      "git status" → ["git", "status"]
 *      "tsc --noEmit" → ["tsc"]
 */
function generalize(command: string): string[] {
  const canonical = canonicalizeCommand(command);
  const segments = tokenizeShellCommand(canonical);
  if (!segments.length || !segments[0].length) return [];
  const first = segments[0];
  // Keep up to 2 tokens (executable + subcommand)
  return first.slice(0, Math.min(2, first.length));
}

function storagePath(): string {
  return path.join(app.getPath("userData"), "approval-rules.json");
}

class CommandApprovalCache {
  private sessionRules: ApprovalEntry[] = [];
  private permanentRules: ApprovalEntry[] = [];
  private loaded = false;

  /** Load permanent rules from disk. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(storagePath(), "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.permanentRules = data.filter(
          (entry: unknown) =>
            entry &&
            typeof entry === "object" &&
            Array.isArray((entry as ApprovalEntry).pattern) &&
            (entry as ApprovalEntry).scope === "permanent",
        );
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.permanentRules = [];
    }
  }

  /** Persist permanent rules to disk. */
  private persist(): void {
    try {
      const dir = path.dirname(storagePath());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        storagePath(),
        JSON.stringify(this.permanentRules, null, 2),
        "utf-8",
      );
    } catch {
      // Silently fail — not critical
    }
  }

  /**
   * Record an approval rule.
   * @param command - The concrete command that was approved
   * @param scope - 'session' (memory only) or 'permanent' (persisted)
   * @param category - Permission category (e.g., 'runCommands')
   * @param workspace - Workspace path to scope permanent rules
   */
  approve(
    command: string,
    scope: "session" | "permanent",
    category: string,
    workspace?: string,
  ): void {
    if (isDenylisted(command)) return; // never cache dangerous commands
    const pattern = generalize(command);
    if (!pattern.length) return;

    // Avoid duplicates
    const rules = scope === "session" ? this.sessionRules : this.permanentRules;
    const exists = rules.some(
      (entry) =>
        entry.pattern.join(" ") === pattern.join(" ") &&
        entry.category === category &&
        (scope === "session" || entry.workspace === workspace),
    );
    if (exists) return;

    const entry: ApprovalEntry = {
      pattern,
      scope,
      category,
      workspace: scope === "permanent" ? workspace : undefined,
      createdAt: Date.now(),
    };

    if (scope === "session") {
      this.sessionRules.push(entry);
    } else {
      this.permanentRules.push(entry);
      this.persist();
    }
  }

  /**
   * Check if a command is pre-approved by cached rules.
   * Returns 'allow' if a matching rule exists, 'prompt' otherwise.
   */
  check(
    command: string,
    category: string,
    workspace?: string,
  ): CommandPolicyAction {
    if (isDenylisted(command)) return "prompt";

    const allRules = this.toCommandPolicyRules(category, workspace);
    if (!allRules.length) return "prompt";

    // Canonicalize the command before matching against stored patterns
    const canonical = canonicalizeCommand(command);
    const result = evaluateCommandPolicy(canonical, allRules);
    return result.action;
  }

  /** Convert cached entries to CommandPolicyRule[] for evaluateCommandPolicy. */
  private toCommandPolicyRules(
    category: string,
    workspace?: string,
  ): CommandPolicyRule[] {
    const rules: CommandPolicyRule[] = [];

    for (const entry of this.sessionRules) {
      if (entry.category !== category) continue;
      rules.push({ action: "allow", match: entry.pattern });
    }

    for (const entry of this.permanentRules) {
      if (entry.category !== category) continue;
      // Permanent rules are scoped to workspace if specified
      if (entry.workspace && workspace && entry.workspace !== workspace)
        continue;
      rules.push({ action: "allow", match: entry.pattern });
    }

    return rules;
  }

  /** Get the generalized pattern for display to user before saving. */
  getPattern(command: string): string {
    const pattern = generalize(command);
    return pattern.length ? pattern.join(" ") + " *" : command;
  }

  /** Clear all session-scoped rules. */
  clearSession(): void {
    this.sessionRules = [];
  }

  /** Remove a specific permanent rule by pattern. */
  removePermanent(pattern: string[]): void {
    this.permanentRules = this.permanentRules.filter(
      (entry) => entry.pattern.join(" ") !== pattern.join(" "),
    );
    this.persist();
  }

  /** List all cached rules (for settings UI). */
  listRules(): ApprovalEntry[] {
    return [...this.sessionRules, ...this.permanentRules];
  }
}

/** Singleton instance. */
export const approvalCache = new CommandApprovalCache();
