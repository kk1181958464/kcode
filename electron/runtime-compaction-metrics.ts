export type RuntimeCompactionReason = "threshold" | "hard_pressure";

export function runtimeCompactionReason(forced: boolean): RuntimeCompactionReason {
  return forced ? "hard_pressure" : "threshold";
}

export function runtimeCompactionMetrics(
  startedAt: number,
  beforeTokens: number,
  afterTokens: number,
) {
  return {
    durationMs: Math.max(0, Date.now() - startedAt),
    tokensSaved: Math.max(0, beforeTokens - afterTokens),
  };
}
