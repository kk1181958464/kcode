/**
 * Middle-Out Truncation — when output exceeds a limit, keep the head and tail
 * and replace the middle with a notice. Models need the beginning (headers,
 * setup info, initial errors) and the end (final result, exit status, summary).
 */

const DEFAULT_HEAD_RATIO = 0.35; // 35% head, 65% tail by default
const SEPARATOR = "\n\n[...truncated middle section...]\n\n";
const SEPARATOR_ZH = "\n\n[...中间部分已截断...]\n\n";

export interface TruncateOptions {
  /** Maximum length in characters. */
  maxLength: number;
  /** Ratio of head portion (0-1). Default: 0.35 */
  headRatio?: number;
  /** Use Chinese separator. Default: true */
  chinese?: boolean;
}

/**
 * Truncate text using middle-out strategy.
 * Keeps the first `headRatio * maxLength` chars and last `(1-headRatio) * maxLength` chars.
 * Returns the original string unchanged if within limit.
 */
export function middleOutTruncate(
  text: string,
  options: TruncateOptions,
): string {
  const { maxLength, headRatio = DEFAULT_HEAD_RATIO, chinese = true } = options;
  if (text.length <= maxLength) return text;

  const separator = chinese ? SEPARATOR_ZH : SEPARATOR;
  const available = maxLength - separator.length;
  if (available <= 0) return text.slice(0, maxLength);

  const headSize = Math.floor(available * headRatio);
  const tailSize = available - headSize;

  // Try to break at line boundaries for cleaner output
  const headEnd = findLineBreak(text, headSize, "backward");
  const tailStart = findLineBreak(text, text.length - tailSize, "forward");

  if (tailStart <= headEnd) {
    // Overlap — just do character-level split
    return text.slice(0, headSize) + separator + text.slice(-tailSize);
  }

  return text.slice(0, headEnd) + separator + text.slice(tailStart);
}

/**
 * Find the nearest line break to `position`.
 * Direction "backward" searches before position, "forward" searches after.
 * Falls back to the exact position if no newline is found within 200 chars.
 */
function findLineBreak(
  text: string,
  position: number,
  direction: "forward" | "backward",
): number {
  const searchRange = 200;
  if (direction === "backward") {
    const start = Math.max(0, position - searchRange);
    const lastNewline = text.lastIndexOf("\n", position);
    if (lastNewline >= start) return lastNewline + 1;
    return position;
  }
  const end = Math.min(text.length, position + searchRange);
  const nextNewline = text.indexOf("\n", position);
  if (nextNewline >= 0 && nextNewline <= end) return nextNewline + 1;
  return position;
}

/**
 * Convenience: truncate command output with sensible defaults.
 * Uses 35% head / 65% tail split — tail-heavy because final output/errors matter more.
 */
export function truncateCommandOutput(
  output: string,
  maxChars = 100_000,
): string {
  return middleOutTruncate(output, { maxLength: maxChars });
}
