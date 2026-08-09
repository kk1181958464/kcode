/**
 * Stop Hooks — pluggable post-turn inspection and forced continuation.
 *
 * After the model finishes a response (no tool calls), stop hooks run to
 * determine if the model should be forced to continue. This complements
 * the existing runtime_verification system with extensible checks.
 */

import type { TurnDiffResult } from "./turn-diff-tracker";

export interface StopHookContext {
  /** The model's response text */
  text: string;
  /** Turn diff result (actual file changes) */
  turnDiff?: TurnDiffResult;
  /** Whether any tool calls were made this turn */
  hadToolCalls: boolean;
  /** Total rounds so far */
  round: number;
  /** Number of consecutive stalled rounds */
  stalledRounds: number;
  /** Whether the model mentioned running tests */
  mentionedTests: boolean;
  /** Whether tests were actually executed (run_command with test-like commands) */
  testsWereRun: boolean;
  /** File changes made this session */
  changedFiles: string[];
  /** The user's latest request/goal (for goal-based continuation) */
  userGoal?: string;
  /** Whether the model has made any tool calls at all during this request */
  hasAnyToolEvidence: boolean;
}

export type StopHookResult =
  | { action: "allow" } // Let the response through
  | { action: "continue"; inject: string }; // Force continuation with injected prompt

export type StopHook = {
  name: string;
  /** Run after the model's turn. Return 'allow' to pass, 'continue' to force another round. */
  evaluate(context: StopHookContext): StopHookResult;
};

/**
 * Hook: Detect when the model claims to have run tests but didn't.
 */
export const testVerificationHook: StopHook = {
  name: "test-verification",
  evaluate(context) {
    // Only trigger when the model mentioned tests but none were actually run
    if (!context.mentionedTests || context.testsWereRun) {
      return { action: "allow" };
    }
    // Don't trigger if no file changes were made (informational response)
    if (!context.changedFiles.length) {
      return { action: "allow" };
    }
    // Don't force if already stalled (avoid infinite loops)
    if (context.stalledRounds >= 2) {
      return { action: "allow" };
    }
    return {
      action: "continue",
      inject:
        "<stop_hook_feedback>你提到了测试但未实际运行。请使用 run_command 执行相关测试命令验证修改是否正确，或明确说明为什么跳过测试。</stop_hook_feedback>",
    };
  },
};

/**
 * Hook: Detect when file changes were claimed but TurnDiffTracker shows none.
 */
export const taskCompletionHook: StopHook = {
  name: "task-completion",
  evaluate(context) {
    // Only relevant when no tool calls were made but text claims changes
    if (context.hadToolCalls) return { action: "allow" };
    if (context.stalledRounds >= 2) return { action: "allow" };

    const claimsFileChanges =
      /已(?:修改|创建|添加|写入|更新|保存)|文件已|已完成(?:修改|编写|实现)/.test(
        context.text,
      );
    if (!claimsFileChanges) return { action: "allow" };

    // No actual changes this turn
    if (context.turnDiff && !context.turnDiff.hasChanges) {
      return {
        action: "continue",
        inject:
          "<stop_hook_feedback>你的回复声称修改了文件，但本轮没有检测到实际文件变更。请使用 apply_patch 或 write_file 工具执行实际修改，或撤回该声明。</stop_hook_feedback>",
      };
    }
    return { action: "allow" };
  },
};

/**
 * Registry for stop hooks.
 */
export class StopHookRegistry {
  private hooks: StopHook[] = [];

  register(hook: StopHook): void {
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  /**
   * Run all hooks. Returns the first "continue" result, or "allow" if all pass.
   */
  evaluate(context: StopHookContext): StopHookResult {
    for (const hook of this.hooks) {
      const result = hook.evaluate(context);
      if (result.action === "continue") return result;
    }
    return { action: "allow" };
  }

  /** Get the count of registered hooks */
  get count(): number {
    return this.hooks.length;
  }
}

/**
 * Hook: Goal-based continuation.
 * Detects when the model responds without addressing the user's actual goal.
 * Triggers when: user asked for an action (modify/create/fix/run), model produced
 * only text with no tool calls, and the response looks like a punt or deferral.
 */
export const goalContinuationHook: StopHook = {
  name: "goal-continuation",
  evaluate(context) {
    // Only applies when model has no tool calls this turn
    if (context.hadToolCalls) return { action: "allow" };
    // Don't loop forever
    if (context.stalledRounds >= 1) return { action: "allow" };
    // If model already used tools in this request, trust that it's done
    if (context.hasAnyToolEvidence) return { action: "allow" };
    // Need a user goal to evaluate against
    if (!context.userGoal) return { action: "allow" };

    // Detect if the user's goal requires action (not just a question)
    const actionGoal = /(?:修改|修复|添加|创建|实现|写|改|删|移动|重构|优化|fix|add|create|implement|write|modify|update|delete|move|refactor|build|install|run|execute|deploy)/i.test(
      context.userGoal,
    );
    if (!actionGoal) return { action: "allow" };

    // Detect if model is punting instead of acting
    const puntingPatterns =
      /(?:你可以|你需要|建议你|可以尝试|以下是.*步骤|here'?s? (?:how|what)|you (?:can|should|need)|I (?:suggest|recommend)|steps to)/i;
    const isPunting = puntingPatterns.test(context.text);

    // Also detect very short responses that don't engage with the task
    const tooShort = context.text.length < 100 && context.round === 1;

    if (isPunting || tooShort) {
      return {
        action: "continue",
        inject: `<stop_hook_feedback>用户要求你执行实际操作（"${context.userGoal.slice(0, 80)}"），但你只给出了建议或说明而没有调用工具。请直接使用工具完成任务，而不是仅描述步骤。</stop_hook_feedback>`,
      };
    }

    return { action: "allow" };
  },
};

/** Default registry with built-in hooks. */
export function createDefaultStopHooks(): StopHookRegistry {
  const registry = new StopHookRegistry();
  registry.register(testVerificationHook);
  registry.register(taskCompletionHook);
  registry.register(goalContinuationHook);
  return registry;
}
