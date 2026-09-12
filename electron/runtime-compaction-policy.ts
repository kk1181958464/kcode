export type RuntimeCompactionDecision = {
  shouldCompact: boolean;
  forced: boolean;
  growth: number;
  availableHistoryTokens: number;
};

export function decideRuntimeCompaction(args: {
  contextWindow?: number;
  promptTokens: number;
  lastCompactionTokens: number;
  systemAndToolTokens?: number;
  outputReserveTokens?: number;
  safetyMarginTokens?: number;
}): RuntimeCompactionDecision {
  const contextWindow = args.contextWindow ?? 0;
  const systemAndToolTokens = args.systemAndToolTokens ?? 0;
  const outputReserveTokens = args.outputReserveTokens ?? Math.max(2_000, Math.floor(contextWindow * 0.08));
  const safetyMarginTokens = args.safetyMarginTokens ?? Math.max(1_000, Math.floor(contextWindow * 0.03));
  const availableHistoryTokens = Math.max(
    0,
    contextWindow - systemAndToolTokens - outputReserveTokens - safetyMarginTokens,
  );
  const forced = Boolean(
    contextWindow &&
      (args.promptTokens >= contextWindow * 0.99 || args.promptTokens > availableHistoryTokens),
  );
  const growth = args.promptTokens - args.lastCompactionTokens;
  const shouldCompact = Boolean(
    args.contextWindow &&
      (args.promptTokens >= availableHistoryTokens * 0.92 || forced) &&
      (args.lastCompactionTokens === 0 ||
        growth >= 3_000 ||
        (forced && growth >= 1_000)),
  );
  return { shouldCompact, forced, growth, availableHistoryTokens };
}
