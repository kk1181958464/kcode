/**
 * Estimates the portion of a model request that is built from the agent
 * history. Some relays omit prompt usage or report a value that excludes
 * tool results, so runtime compaction must not depend on provider accounting.
 */
export const RUNTIME_PROMPT_OVERHEAD_TOKENS = 48_000;

// History items are replaced rather than mutated, and the budget is estimated
// several times per round, so cache each item's serialized length.
const serializedLengths = new WeakMap<object, number>();

function serializedLength(value: unknown) {
  const cacheable = typeof value === "object" && value !== null;
  if (cacheable) {
    const cached = serializedLengths.get(value);
    if (cached !== undefined) return cached;
  }
  let length: number;
  try {
    length = JSON.stringify(value)?.length ?? 0;
  } catch {
    length = String(value).length;
  }
  if (cacheable) serializedLengths.set(value, length);
  return length;
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
