/**
 * Plan Mode Semantic Authorization — after a user approves a plan,
 * grant semantic permissions (e.g., "run tests", "build", "lint")
 * that auto-approve matching commands without exact string matching.
 *
 * Inspired by Claude Code's plan mode that grants tool-use permissions
 * based on semantic intent rather than command-level approval.
 *
 * Flow:
 * 1. User approves a plan with stated actions (e.g., "modify auth, run tests")
 * 2. System extracts semantic permissions from the plan
 * 3. Commands matching those semantic categories auto-approve
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SemanticPermission =
  | "run_tests"
  | "build"
  | "lint"
  | "format"
  | "install_deps"
  | "type_check"
  | "dev_server"
  | "git_operations"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "custom";

export interface SemanticGrant {
  /** The semantic permission category */
  permission: SemanticPermission;
  /** Optional scope constraint (e.g., specific directory) */
  scope?: string;
  /** When this grant was issued */
  grantedAt: number;
  /** Source of the grant (plan step reference) */
  source: string;
}

export interface PlanAuthContext {
  /** Active semantic grants for this session */
  grants: SemanticGrant[];
  /** Whether plan mode is active */
  planActive: boolean;
  /** The approved plan text (for audit) */
  planText?: string;
}

// ─── Command Pattern Matching ────────────────────────────────────────────────

/**
 * Patterns that identify semantic permission categories from commands.
 */
const PERMISSION_PATTERNS: Record<SemanticPermission, RegExp[]> = {
  run_tests: [
    /\b(jest|vitest|mocha|pytest|cargo\s+test|go\s+test|npm\s+test|npx\s+test|yarn\s+test|pnpm\s+test)\b/i,
    /\b(node\s+--test|bun\s+test)\b/i,
    /\btest\b.*\.(js|ts|py|rs|go)\b/i,
  ],
  build: [
    /\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|cargo\s+build|go\s+build|make\s+build|tsc\s+-b|vite\s+build|webpack)\b/i,
    /\bnpx\s+tsc\b/i,
  ],
  lint: [
    /\b(eslint|biome|prettier\s+--check|pylint|flake8|clippy|golangci-lint|npm\s+run\s+lint|yarn\s+lint)\b/i,
  ],
  format: [
    /\b(prettier\s+--write|biome\s+format|black|gofmt|rustfmt|npm\s+run\s+format)\b/i,
  ],
  install_deps: [
    /\b(npm\s+install|npm\s+i|yarn\s+(install|add)|pnpm\s+(install|add)|pip\s+install|cargo\s+add|go\s+get)\b/i,
  ],
  type_check: [
    /\b(tsc\s+--noEmit|npx\s+tsc\s+--noEmit|mypy|pyright)\b/i,
  ],
  dev_server: [
    /\b(npm\s+run\s+dev|yarn\s+dev|pnpm\s+dev|vite|next\s+dev|webpack\s+serve)\b/i,
  ],
  git_operations: [
    /\b(git\s+(add|commit|push|pull|checkout|branch|merge|rebase|stash|status|diff|log))\b/i,
  ],
  file_read: [],   // Handled by tool type, not command
  file_write: [],  // Handled by tool type, not command
  file_delete: [], // Handled by tool type, not command
  custom: [],      // User-defined patterns
};

/**
 * Patterns to extract semantic permissions from plan text.
 */
const PLAN_PERMISSION_EXTRACTORS: Array<{
  pattern: RegExp;
  permission: SemanticPermission;
}> = [
  { pattern: /(?:run|execute)\s+(?:the\s+)?tests?/i, permission: "run_tests" },
  { pattern: /(?:运行|执行)\s*测试/i, permission: "run_tests" },
  { pattern: /(?:build|compile|编译|构建)/i, permission: "build" },
  { pattern: /(?:lint|check\s+style|代码检查)/i, permission: "lint" },
  { pattern: /(?:format|格式化)/i, permission: "format" },
  { pattern: /(?:install|安装)\s*(?:dep|依赖|包)/i, permission: "install_deps" },
  { pattern: /(?:type[- ]?check|类型检查)/i, permission: "type_check" },
  { pattern: /(?:start|run)\s+(?:dev|development)\s+server/i, permission: "dev_server" },
  { pattern: /git\s+(?:commit|push|操作)/i, permission: "git_operations" },
  { pattern: /(?:modify|edit|write|create|修改|编写|创建)\s+(?:files?|文件)/i, permission: "file_write" },
  { pattern: /(?:delete|remove|删除)\s+(?:files?|文件)/i, permission: "file_delete" },
];

// ─── Plan Auth Manager ──────────────────────────────────────────────────────

/**
 * Manages semantic permissions granted through plan approval.
 */
export class PlanSemanticAuth {
  private grants: SemanticGrant[] = [];
  private planActive = false;
  private planText?: string;

  /**
   * Activate plan mode with granted permissions extracted from plan text.
   */
  activatePlan(planText: string): SemanticGrant[] {
    this.planActive = true;
    this.planText = planText;
    this.grants = extractPermissionsFromPlan(planText);
    return this.grants;
  }

  /**
   * Manually grant a specific permission.
   */
  grant(permission: SemanticPermission, source: string, scope?: string): void {
    // Avoid duplicates
    if (this.grants.some((g) => g.permission === permission && g.scope === scope)) {
      return;
    }
    this.grants.push({
      permission,
      scope,
      grantedAt: Date.now(),
      source,
    });
  }

  /**
   * Check if a command is authorized by current semantic grants.
   * Returns true if the command matches any active grant.
   */
  isAuthorized(command: string): boolean {
    if (!this.planActive || this.grants.length === 0) return false;
    return this.grants.some((grant) =>
      matchesPermission(command, grant.permission, grant.scope),
    );
  }

  /**
   * Check if a tool call is authorized by semantic grants.
   */
  isToolAuthorized(toolName: string, input?: Record<string, unknown>): boolean {
    if (!this.planActive || this.grants.length === 0) return false;

    // Map tool names to permissions
    if (
      toolName === "read_file" ||
      toolName === "read_many_files" ||
      toolName === "list_directory" ||
      toolName === "glob_files" ||
      toolName === "search_code"
    ) {
      return this.hasGrant("file_read");
    }

    if (toolName === "write_file" || toolName === "apply_patch" || toolName === "make_directory") {
      return this.hasGrant("file_write");
    }

    if (toolName === "delete_path") {
      return this.hasGrant("file_delete");
    }

    if (toolName === "run_command" && input?.command) {
      return this.isAuthorized(String(input.command));
    }

    return false;
  }

  /**
   * Check if a specific permission is granted.
   */
  hasGrant(permission: SemanticPermission): boolean {
    return this.grants.some((g) => g.permission === permission);
  }

  /**
   * Deactivate plan mode and revoke all grants.
   */
  deactivate(): void {
    this.planActive = false;
    this.grants = [];
    this.planText = undefined;
  }

  /**
   * Get current auth context (for serialization/display).
   */
  getContext(): PlanAuthContext {
    return {
      grants: [...this.grants],
      planActive: this.planActive,
      planText: this.planText,
    };
  }

  /**
   * Whether plan mode is currently active.
   */
  get isActive(): boolean {
    return this.planActive;
  }

  /**
   * Number of active grants.
   */
  get grantCount(): number {
    return this.grants.length;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract semantic permissions from plan text.
 */
export function extractPermissionsFromPlan(planText: string): SemanticGrant[] {
  const grants: SemanticGrant[] = [];
  const seen = new Set<SemanticPermission>();

  for (const { pattern, permission } of PLAN_PERMISSION_EXTRACTORS) {
    if (pattern.test(planText) && !seen.has(permission)) {
      seen.add(permission);
      grants.push({
        permission,
        grantedAt: Date.now(),
        source: "plan_approval",
      });
    }
  }

  // Always grant file_read for any plan (models need to read to act)
  if (!seen.has("file_read")) {
    grants.push({
      permission: "file_read",
      grantedAt: Date.now(),
      source: "plan_approval_implicit",
    });
  }

  return grants;
}

/**
 * Check if a command matches a semantic permission category.
 */
function matchesPermission(
  command: string,
  permission: SemanticPermission,
  scope?: string,
): boolean {
  // Check scope constraint first
  if (scope && !command.includes(scope)) {
    return false;
  }

  const patterns = PERMISSION_PATTERNS[permission];
  if (!patterns || patterns.length === 0) return false;

  return patterns.some((p) => p.test(command));
}
