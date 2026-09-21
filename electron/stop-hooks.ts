/**
 * Stop hooks inspect structured runtime state before a no-tool model turn is
 * accepted as final. They must never infer execution from assistant prose.
 */

export interface StopHookContext {
  /** Side effects implied by native calls already attempted in this run. */
  requestedOperations: string[];
  /** Successful operations recorded by native tools in this request. */
  observedOperations: string[];
  /** Requested operations still lacking successful runtime evidence. */
  missingOperations: string[];
  /** Number of structured completion retries already requested. */
  retryCount: number;
  /** A native request_user_input tool already paused the request. */
  waitingForUser: boolean;
  /**
   * When true, missing evidence may end as incomplete (hard run budget or an
   * explicit pause). Soft retries alone must not stop unfinished work.
   */
  allowIncomplete?: boolean;
}

export type StopHookResult =
  | { action: "allow" }
  | { action: "continue"; inject: string; forceToolCall?: boolean };

export type StopHook = {
  name: string;
  evaluate(context: StopHookContext): StopHookResult;
};

/**
 * Providers occasionally ignore a required tool choice and return prose.
 *
 * Soft retries nudge once. Then keep forceToolCall until the Codex-style
 * consecutive unproductive ceiling, and only then allow an honest
 * `incomplete` stop.
 */
export const REQUIRED_EVIDENCE_SOFT_RETRY_LIMIT = 1;
export const REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT = 3;
/** @deprecated Use REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT; kept for call sites. */
export const REQUIRED_EVIDENCE_RETRY_LIMIT = REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT;

/**
 * Consecutive empty / reasoning-only / no-tool turns (Codex empty-response
 * fuse). After this many unproductive rounds the run must stop rather than
 * keep burning soft retries.
 */
export const CONSECUTIVE_UNPRODUCTIVE_TURN_LIMIT = 3;

function missingEvidenceInject(missingOperations: string[], forceTool: boolean) {
  const ops = missingOperations.join(", ");
  const audit = [
    "完成审计（未完成前禁止收尾）：",
    "- 把目标拆成可核对的交付物/成功标准，并逐项对照当前权威状态（文件、命令输出、测试结果等）。",
    "- 计划、todo 更新、耗时、“看起来像做完”的总结都不算完成证据。",
    "- 证据不足、间接或只覆盖部分要求时，视为未完成，继续推进最小下一步。",
    "- 同一 blocker 连续出现时不要空转复述；改为调用工具改变状态，或在确需用户时用 request_user_input。",
  ].join("\n");
  if (forceTool)
    return `<runtime_hook>本次请求仍缺少这些结构化运行记录：${ops}。禁止只输出总结。下一轮必须调用对应工具推进；若检查后确认无需修改，请使用 report_no_change；若必须由用户补充信息，请使用 request_user_input。不要仅用文字宣称操作已经完成。\n${audit}</runtime_hook>`;
  return `<runtime_hook>本次请求仍缺少这些结构化运行记录：${ops}。如果操作尚未发生，请立即调用对应工具；如果检查后确认无需修改，请使用 report_no_change；如果必须由用户补充信息，请使用 request_user_input。不要仅用文字宣称操作已经完成。\n${audit}</runtime_hook>`;
}

export const requiredEvidenceHook: StopHook = {
  name: "required-runtime-evidence",
  evaluate(context) {
    if (context.waitingForUser || !context.missingOperations.length)
      return { action: "allow" };
    if (context.allowIncomplete) return { action: "allow" };
    if (context.retryCount >= REQUIRED_EVIDENCE_FORCE_RETRY_LIMIT)
      return { action: "allow" };

    const forceToolCall =
      context.retryCount >= REQUIRED_EVIDENCE_SOFT_RETRY_LIMIT;
    return {
      action: "continue",
      forceToolCall: true,
      inject: missingEvidenceInject(context.missingOperations, forceToolCall),
    };
  },
};

export class StopHookRegistry {
  private hooks: StopHook[] = [];

  register(hook: StopHook): void {
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((hook) => hook.name !== name);
  }

  evaluate(context: StopHookContext): StopHookResult {
    for (const hook of this.hooks) {
      const result = hook.evaluate(context);
      if (result.action === "continue") return result;
    }
    return { action: "allow" };
  }

  get count(): number {
    return this.hooks.length;
  }
}

export function createDefaultStopHooks(): StopHookRegistry {
  const registry = new StopHookRegistry();
  registry.register(requiredEvidenceHook);
  return registry;
}
