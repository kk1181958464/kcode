import { findScopeRange, parseScopeHint } from "./patch-scope";

export function normalizeLineEndings(value: string) {
  return value.replace(/\r\n|\r/g, "\n");
}

function preferredLineEnding(value: string) {
  const crlfCount = value.match(/\r\n/g)?.length ?? 0;
  const withoutCrlf = value.replace(/\r\n/g, "");
  const lfCount = withoutCrlf.match(/\n/g)?.length ?? 0;
  const crCount = withoutCrlf.match(/\r/g)?.length ?? 0;
  if (crlfCount >= lfCount && crlfCount >= crCount && crlfCount > 0)
    return "\r\n";
  if (crCount > lfCount) return "\r";
  return "\n";
}

// ─── Four-Level Fuzzy Seek Matching ─────────────────────────────────────────

/** Level 1: Exact match */
function exactMatch(a: string, b: string): boolean {
  return a === b;
}

/** Level 2: Whitespace-normalized (collapse runs of whitespace to single space) */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
function whitespaceMatch(a: string, b: string): boolean {
  return normalizeWhitespace(a) === normalizeWhitespace(b);
}

/** Level 3: Indentation-ignored (strip leading whitespace, exact rest) */
function stripIndent(s: string): string {
  return s.trimStart();
}
function indentMatch(a: string, b: string): boolean {
  return stripIndent(a) === stripIndent(b);
}

/** Level 4: Levenshtein distance within threshold (for typos / minor edits) */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Use two-row optimization for memory efficiency
  const aLen = a.length;
  const bLen = b.length;

  // Early exit: if length difference alone exceeds any reasonable threshold
  if (Math.abs(aLen - bLen) > Math.max(aLen, bLen) * 0.3) return Infinity;

  let prev = Array.from({ length: bLen + 1 }, (_, i) => i);
  let curr = new Array<number>(bLen + 1);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bLen];
}

/**
 * Maximum edit distance ratio to consider a fuzzy match.
 * 0.25 means up to 25% of the shorter string's length can differ.
 */
const FUZZY_THRESHOLD_RATIO = 0.25;

function fuzzyMatch(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const threshold = Math.max(3, Math.floor(maxLen * FUZZY_THRESHOLD_RATIO));
  const distance = levenshteinDistance(a, b);
  return distance <= threshold;
}

/**
 * Four-level fuzzy seek: find the best match for `value` in `source[start..end)`.
 * Returns the index of the matched line, or -1 if no match at any level.
 *
 * Priority: exact > whitespace-normalized > indent-ignored > Levenshtein.
 * Higher levels are only attempted if lower levels fail.
 */
function fuzzySeek(
  source: readonly string[],
  value: string,
  start: number,
  end?: number,
): number {
  const limit = end ?? source.length;

  // Level 1: Exact match
  for (let i = start; i < limit; i++) {
    if (exactMatch(source[i], value)) return i;
  }

  // Level 2: Whitespace-normalized
  const normalizedValue = normalizeWhitespace(value);
  if (normalizedValue) {
    for (let i = start; i < limit; i++) {
      if (normalizeWhitespace(source[i]) === normalizedValue) return i;
    }
  }

  // Level 3: Indentation-ignored
  const strippedValue = stripIndent(value);
  if (strippedValue) {
    for (let i = start; i < limit; i++) {
      if (stripIndent(source[i]) === strippedValue) return i;
    }
  }

  // Level 4: Levenshtein fuzzy match (only for non-trivial lines)
  if (value.trim().length >= 4) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    const maxLen = value.length;
    const threshold = Math.max(3, Math.floor(maxLen * FUZZY_THRESHOLD_RATIO));

    for (let i = start; i < limit; i++) {
      // Skip empty lines for fuzzy matching
      if (!source[i].trim()) continue;
      const distance = levenshteinDistance(source[i], value);
      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) return bestIndex;
  }

  return -1;
}

// ─── Main Patch Application ─────────────────────────────────────────────────

export function applyUpdatePatch(original: string, lines: readonly string[]) {
  const lineEnding = preferredLineEnding(original);
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const source = normalizeLineEndings(original.slice(bom.length)).split("\n");
  let cursor = 0;
  const output: string[] = [];

  // Track active scope constraint (from @@ lines)
  let scopeStart: number | undefined;
  let scopeEnd: number | undefined;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Extract scope hint: "@@ functionName" or "@@ ClassName.method"
      const scopeHint = parseScopeHint(line);
      if (scopeHint) {
        const range = findScopeRange(source, scopeHint);
        if (range) {
          scopeStart = range.startLine;
          scopeEnd = range.endLine;
          // If cursor is before scope start, advance to scope start
          // but only if we haven't already output lines past it
          if (cursor < scopeStart) {
            output.push(...source.slice(cursor, scopeStart));
            cursor = scopeStart;
          }
        }
        // If scope not found, fall back to full-file matching (no constraint)
      }
      continue;
    }
    const marker = line[0];
    const value = line.slice(1);
    if (marker === " ") {
      const searchEnd = scopeEnd !== undefined ? scopeEnd + 1 : undefined;
      const index = fuzzySeek(source, value, cursor, searchEnd);
      if (index < 0) {
        // Fallback: try without scope constraint
        const fallbackIndex = fuzzySeek(source, value, cursor);
        if (fallbackIndex < 0)
          throw new Error(`补丁上下文不匹配：${value}`);
        output.push(...source.slice(cursor, fallbackIndex + 1));
        cursor = fallbackIndex + 1;
      } else {
        output.push(...source.slice(cursor, index + 1));
        cursor = index + 1;
      }
    } else if (marker === "-") {
      const searchEnd = scopeEnd !== undefined ? scopeEnd + 1 : undefined;
      const index = fuzzySeek(source, value, cursor, searchEnd);
      if (index < 0) {
        // Fallback: try without scope constraint
        const fallbackIndex = fuzzySeek(source, value, cursor);
        if (fallbackIndex < 0)
          throw new Error(`补丁删除内容不匹配：${value}`);
        output.push(...source.slice(cursor, fallbackIndex));
        cursor = fallbackIndex + 1;
      } else {
        output.push(...source.slice(cursor, index));
        cursor = index + 1;
      }
    } else if (marker === "+") output.push(value);
    else if (line) throw new Error(`无法识别的补丁行：${line}`);
  }

  output.push(...source.slice(cursor));
  return bom + output.join(lineEnding);
}
