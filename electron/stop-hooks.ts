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
}

export type StopHookResult =
  | { action: "allow" }
  | { action: "continue"; inject: string };

export type StopHook = {
  name: string;
  evaluate(context: StopHookContext): StopHookResult;
};

/**
 * Providers occasionally ignore a required tool choice and return prose. Give
 * them one structured retry, then preserve the answer and let the runtime mark
 * the missing evidence as incomplete instead of manufacturing a red failure.
 */
export const requiredEvidenceHook: StopHook = {
  name: "required-runtime-evidence",
  evaluate(context) {
    if (
      context.waitingForUser ||
      !context.missingOperations.length ||
      context.retryCount >= 1
    )
      return { action: "allow" };

    return {
      action: "continue",
      inject: `<runtime_hook>本次请求仍缺少这些结构化运行记录：${context.missingOperations.join(", ")}。如果操作尚未发生，请立即调用对应工具；如果检查后确认无需修改，请使用 report_no_change；如果必须由用户补充信息，请使用 request_user_input。不要仅用文字宣称操作已经完成。</runtime_hook>`,
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
