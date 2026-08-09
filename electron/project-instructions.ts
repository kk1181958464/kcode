/**
 * Project Instructions — automatically loads `.kcode/KCODE.md` from the
 * workspace root (and optionally parent directories) into the system prompt.
 *
 * Inspired by Claude Code's CLAUDE.md mechanism: project-specific constraints
 * and instructions loaded without user repetition each session.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const INSTRUCTIONS_FILENAME = "KCODE.md";
const INSTRUCTIONS_DIR = ".kcode";
const MAX_INSTRUCTIONS_SIZE = 50_000; // 50KB max to avoid prompt bloat
const MAX_PARENT_DEPTH = 5; // Don't walk up more than 5 levels

/** Cache entry for project instructions. */
interface CacheEntry {
  content: string;
  mtimeMs: number;
  loadedAt: number;
}

/** In-memory cache keyed by absolute file path. */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // Refresh every 30s

/**
 * Load project instructions for a given workspace root.
 * Searches for `.kcode/KCODE.md` starting from `root` and walking up
 * parent directories. Instructions are merged (parent first, child appends).
 *
 * Returns empty string if no instructions found.
 */
export function loadProjectInstructions(root: string): string {
  const files = findInstructionFiles(root);
  if (!files.length) return "";

  const sections: string[] = [];
  for (const filePath of files) {
    const content = readCached(filePath);
    if (content) sections.push(content);
  }

  if (!sections.length) return "";

  // Wrap in XML tags for clear delineation in the system prompt
  const merged = sections.join("\n\n---\n\n");
  const truncated =
    merged.length > MAX_INSTRUCTIONS_SIZE
      ? merged.slice(0, MAX_INSTRUCTIONS_SIZE) + "\n\n[...项目指令已截断...]"
      : merged;

  return `\n\n<project_instructions>\n${truncated}\n</project_instructions>`;
}

/**
 * Find all KCODE.md files from root upward (parent directories).
 * Returns paths ordered parent-first (outermost ancestor → root).
 */
function findInstructionFiles(root: string): string[] {
  const files: string[] = [];
  let current = path.resolve(root);
  let depth = 0;

  while (depth < MAX_PARENT_DEPTH) {
    const candidate = path.join(current, INSTRUCTIONS_DIR, INSTRUCTIONS_FILENAME);
    if (fs.existsSync(candidate)) {
      files.unshift(candidate); // Parent-first order
    }

    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
    depth++;
  }

  return files;
}

/**
 * Read a file with simple mtime-based caching.
 * Returns null if file is unreadable or empty.
 */
function readCached(filePath: string): string | null {
  const now = Date.now();
  const cached = cache.get(filePath);

  // Check if cache is still fresh
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.content || null;
  }

  try {
    const stat = fs.statSync(filePath);

    // If mtime hasn't changed and we have a cached version, reuse it
    if (cached && stat.mtimeMs === cached.mtimeMs) {
      cached.loadedAt = now;
      return cached.content || null;
    }

    const content = fs.readFileSync(filePath, "utf-8").trim();
    cache.set(filePath, { content, mtimeMs: stat.mtimeMs, loadedAt: now });
    return content || null;
  } catch {
    // File disappeared or became unreadable
    cache.delete(filePath);
    return null;
  }
}

/**
 * Invalidate the cache for a specific root (e.g., after user edits KCODE.md).
 */
export function invalidateInstructionsCache(root?: string): void {
  if (!root) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(root)) cache.delete(key);
  }
}

/**
 * Check if a workspace has project instructions configured.
 */
export function hasProjectInstructions(root: string): boolean {
  const candidate = path.join(root, INSTRUCTIONS_DIR, INSTRUCTIONS_FILENAME);
  return fs.existsSync(candidate);
}
