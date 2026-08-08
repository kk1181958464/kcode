export type ContextUsageSource = "reported" | "estimated" | "partial";

export type ContextWindowState = {
  windowId: string;
  limit?: number;
  observedTokens?: number;
  estimatedTokens: number;
  source: ContextUsageSource;
  compactionCount: number;
  updatedAt: number;
  lastCompactedAt?: number;
};

export function contextWindowId(taskId: string, generation = 0) {
  return `${taskId}:context:${Math.max(0, Math.floor(generation))}`;
}

export function observeContextWindow(
  previous: ContextWindowState | undefined,
  input: {
    taskId: string;
    limit?: number;
    observedTokens?: number;
    estimatedTokens: number;
    source: ContextUsageSource;
  },
) {
  const state: ContextWindowState = previous ?? {
    windowId: contextWindowId(input.taskId),
    estimatedTokens: 0,
    source: "estimated",
    compactionCount: 0,
    updatedAt: 0,
  };
  return {
    ...state,
    limit: input.limit ?? state.limit,
    observedTokens: input.observedTokens ?? state.observedTokens,
    estimatedTokens: Math.max(0, Math.floor(input.estimatedTokens)),
    source: input.source,
    updatedAt: Date.now(),
  } satisfies ContextWindowState;
}

export function markContextCompacted(
  previous: ContextWindowState | undefined,
  taskId: string,
  estimatedTokens: number,
  limit?: number,
  at = Date.now(),
) {
  const nextCount = (previous?.compactionCount ?? 0) + 1;
  return {
    windowId: contextWindowId(taskId, nextCount),
    limit: limit ?? previous?.limit,
    estimatedTokens: Math.max(0, Math.floor(estimatedTokens)),
    source: "estimated" as const,
    compactionCount: nextCount,
    updatedAt: at,
    lastCompactedAt: at,
  } satisfies ContextWindowState;
}

export function contextUsageTokens(
  state: ContextWindowState | undefined,
  fallback: number,
) {
  return Math.max(
    0,
    Math.floor(state?.observedTokens ?? state?.estimatedTokens ?? fallback),
  );
}

export function contextPercent(tokens: number, limit?: number) {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((tokens / limit) * 100)));
}
