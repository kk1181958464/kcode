export type AgentHookName =
  | "SessionStart"
  | "BeforeTool"
  | "AfterTool"
  | "BeforeCompact"
  | "AfterCompact";

export type AgentHookContext = {
  requestId: string;
  taskId?: string;
  tool?: string;
  activityId?: string;
  payload?: Record<string, unknown>;
};

export type AgentHook = (
  context: AgentHookContext,
  signal?: AbortSignal,
) => void | Promise<void>;

/** Small hook surface for Skills/MCP integrations without coupling them to UI. */
export class AgentHookRegistry {
  private readonly hooks = new Map<AgentHookName, Set<AgentHook>>();

  register(name: AgentHookName, hook: AgentHook) {
    const hooks = this.hooks.get(name) ?? new Set<AgentHook>();
    hooks.add(hook);
    this.hooks.set(name, hooks);
    return () => hooks.delete(hook);
  }

  async run(
    name: AgentHookName,
    context: AgentHookContext,
    signal?: AbortSignal,
  ) {
    for (const hook of this.hooks.get(name) ?? []) {
      if (signal?.aborted) return;
      await hook(context, signal);
    }
  }

  clear() {
    this.hooks.clear();
  }
}

export const agentHooks = new AgentHookRegistry();
