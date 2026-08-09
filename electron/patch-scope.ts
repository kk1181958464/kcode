/**
 * Scope-aware patch targeting.
 * Parses @@ scope headers to narrow down context search ranges in patches.
 * Supports brace-delimited languages (JS/TS/Go/Rust/Java/C#) and
 * indentation-delimited languages (Python).
 */

export interface ScopeRange {
  startLine: number; // 0-based inclusive
  endLine: number; // 0-based inclusive
}

/**
 * Extract the scope name from an @@ line.
 * Formats: "@@ functionName", "@@ ClassName.methodName", "@@ ClassName"
 * Returns undefined if no usable scope name.
 */
export function parseScopeHint(line: string): string | undefined {
  const trimmed = line.replace(/^@@\s*/, "").trim();
  if (!trimmed || /^\d/.test(trimmed)) return undefined;
  // Strip trailing whitespace and common noise (line numbers etc)
  return trimmed.split(/\s+/)[0] || undefined;
}

/**
 * Find the line range of a named scope (function/class/method) in source lines.
 * Searches for declarations matching the scope name, then determines the block extent.
 *
 * Returns the range [startLine, endLine] (0-based) or undefined if not found.
 */
export function findScopeRange(
  sourceLines: readonly string[],
  scopeName: string,
): ScopeRange | undefined {
  // Support dotted names: "ClassName.methodName"
  const parts = scopeName.split(".");
  const target = parts[parts.length - 1];
  const container = parts.length > 1 ? parts[0] : undefined;

  let searchStart = 0;

  // If there's a container, first locate it and search inside
  if (container) {
    const containerRange = findDeclaration(sourceLines, container, 0);
    if (!containerRange) return undefined;
    searchStart = containerRange.startLine;
    const end = containerRange.endLine;
    // Now look for the method within the container range
    return findDeclaration(sourceLines, target, searchStart, end);
  }

  return findDeclaration(sourceLines, target, searchStart);
}

/**
 * Find a declaration by name and determine its block extent.
 */
function findDeclaration(
  sourceLines: readonly string[],
  name: string,
  from: number,
  to?: number,
): ScopeRange | undefined {
  const limit = to ?? sourceLines.length - 1;
  const escaped = escapeRegex(name);

  // Match common declaration patterns:
  // function name(, async function name(, const name =, let name =,
  // class name, def name(, fn name(, func name(, pub fn name(,
  // methodName(, methodName =(, export function name(, private name(
  const patterns = [
    new RegExp(`\\b(?:function|async\\s+function)\\s+${escaped}\\s*[(<]`),
    new RegExp(
      `\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(|=>|function)`,
    ),
    new RegExp(`\\b(?:class|interface|enum|type|struct)\\s+${escaped}\\b`),
    new RegExp(`\\b(?:def|fn|func|pub\\s+fn|pub\\s+func)\\s+${escaped}\\s*\\(`),
    new RegExp(
      `\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`,
    ),
    new RegExp(
      `\\b(?:public|private|protected|internal|static|async|override|virtual|abstract)\\s+.*\\b${escaped}\\s*\\(`,
    ),
    // Bare method: "  methodName(" at indentation
    new RegExp(`^\\s+${escaped}\\s*\\(`),
    // Go receiver method: "func (r *Type) Name("
    new RegExp(`\\bfunc\\s+\\([^)]*\\)\\s+${escaped}\\s*\\(`),
  ];

  for (let i = from; i <= limit; i++) {
    const line = sourceLines[i];
    if (patterns.some((pattern) => pattern.test(line))) {
      const endLine = findBlockEnd(sourceLines, i, limit);
      return { startLine: i, endLine };
    }
  }

  return undefined;
}

/**
 * Find the end of a block starting at `startLine`.
 * For brace-delimited: counts { } balance.
 * For Python (def/class with colon): uses indentation.
 */
function findBlockEnd(
  sourceLines: readonly string[],
  startLine: number,
  maxLine: number,
): number {
  const firstLine = sourceLines[startLine];

  // Detect Python-style indentation blocks
  if (/^\s*(?:def|class)\s/.test(firstLine) && firstLine.trimEnd().endsWith(":")) {
    return findIndentationEnd(sourceLines, startLine, maxLine);
  }

  // Brace-delimited block
  return findBraceEnd(sourceLines, startLine, maxLine);
}

/**
 * Find end of brace-delimited block.
 */
function findBraceEnd(
  sourceLines: readonly string[],
  startLine: number,
  maxLine: number,
): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i <= maxLine; i++) {
    const line = sourceLines[i];
    for (const char of line) {
      if (char === "{") {
        depth++;
        foundOpen = true;
      } else if (char === "}") {
        depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
  }

  // If no brace found, use a heuristic: next blank line or function declaration
  if (!foundOpen) {
    for (let i = startLine + 1; i <= maxLine; i++) {
      if (sourceLines[i].trim() === "") return i - 1;
    }
  }

  return maxLine;
}

/**
 * Find end of indentation-delimited block (Python).
 */
function findIndentationEnd(
  sourceLines: readonly string[],
  startLine: number,
  maxLine: number,
): number {
  const baseIndent = getIndent(sourceLines[startLine]);
  let lastContent = startLine;

  for (let i = startLine + 1; i <= maxLine; i++) {
    const line = sourceLines[i];
    // Skip blank lines
    if (line.trim() === "") continue;
    const indent = getIndent(line);
    // If indent is back at or before base level, block is done
    if (indent <= baseIndent) return lastContent;
    lastContent = i;
  }

  return lastContent;
}

function getIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  if (!match) return 0;
  let count = 0;
  for (const char of match[1]) {
    count += char === "\t" ? 4 : 1;
  }
  return count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
