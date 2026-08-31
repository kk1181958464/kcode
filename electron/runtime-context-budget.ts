/**
 * Estimates the portion of a model request that is built from the agent
 * history. Some relays omit prompt usage or report a value that excludes
 * tool results, so runtime compaction must not depend on provider accounting.
 */
export const RUNTIME_PROMPT_OVERHEAD_TOKENS = 48_000;

function serializedLength(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

export function estimateRuntimeHistoryTokens(history: readonly unknown[]) {
  const characters = history.reduce<number>(
    (total, item) => total + serializedLength(item),
    0,
  );
  return Math.ceil(characters / 3);
}

/** Returns a conservative current-prompt estimate for compaction decisions. */
export function effectiveRuntimePromptTokens(
  history: readonly unknown[],
  reportedTokens = 0,
) {
  return Math.max(
    Math.max(0, Math.floor(reportedTokens)),
    estimateRuntimeHistoryTokens(history) + RUNTIME_PROMPT_OVERHEAD_TOKENS,
  );
}
