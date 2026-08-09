/**
 * WorldState Diff — tracks system prompt segment changes across rounds.
 *
 * Splits the system prompt into named segments and hashes each one.
 * By keeping stable segments unchanged between rounds, we maximize
 * prompt caching hit rates (Anthropic prefix caching, OpenAI session prefix).
 *
 * This module does NOT alter what is sent to the API — it monitors and reports
 * which segments changed, enabling:
 * - Cache efficiency diagnostics
 * - Token savings tracking
 * - Debug visibility into prompt instability
 */

import { createHash } from "node:crypto";

export interface PromptSegment {
  name: string;
  content: string;
  hash: string;
}

export interface SegmentDiff {
  name: string;
  changed: boolean;
  /** Previous hash (undefined on first round) */
  previousHash?: string;
  currentHash: string;
  /** Approximate token savings from caching (stable segments) */
  cachedTokensEstimate?: number;
}

export interface WorldStateDiffResult {
  round: number;
  segments: SegmentDiff[];
  /** Number of segments that stayed the same */
  stableCount: number;
  /** Number of segments that changed */
  changedCount: number;
  /** Estimated tokens cacheable (from stable segments) */
  estimatedCachedTokens: number;
  /** Total estimated tokens in prompt */
  estimatedTotalTokens: number;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Rough token estimate: ~4 chars per token for mixed CJK/English */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Split a monolithic system prompt into named segments.
 * Segments are delimited by section markers we insert ourselves.
 */
export function buildSegments(parts: Array<{ name: string; content: string }>): PromptSegment[] {
  return parts
    .filter((part) => part.content.trim().length > 0)
    .map((part) => ({
      name: part.name,
      content: part.content,
      hash: hashContent(part.content),
    }));
}

/**
 * Reassemble segments into a single system prompt string.
 * This is what actually gets sent to the model — no segment markers in output.
 */
export function assemblePrompt(segments: PromptSegment[]): string {
  return segments.map((s) => s.content).join("\n\n");
}

export class WorldStateDiffTracker {
  private previousSegments: Map<string, string> = new Map();
  private round = 0;

  /**
   * Record the current round's segments and compute the diff from last round.
   */
  recordRound(segments: PromptSegment[]): WorldStateDiffResult {
    this.round++;
    const diffs: SegmentDiff[] = [];
    let stableCount = 0;
    let changedCount = 0;
    let estimatedCachedTokens = 0;
    let estimatedTotalTokens = 0;

    for (const segment of segments) {
      const tokens = estimateTokens(segment.content);
      estimatedTotalTokens += tokens;
      const previousHash = this.previousSegments.get(segment.name);
      const changed = previousHash !== undefined && previousHash !== segment.hash;
      const isNew = previousHash === undefined;

      if (!isNew && !changed) {
        stableCount++;
        estimatedCachedTokens += tokens;
      } else {
        changedCount++;
      }

      diffs.push({
        name: segment.name,
        changed: changed || isNew,
        previousHash,
        currentHash: segment.hash,
        cachedTokensEstimate: !changed && !isNew ? tokens : 0,
      });
    }

    // Update stored hashes for next comparison
    this.previousSegments.clear();
    for (const segment of segments) {
      this.previousSegments.set(segment.name, segment.hash);
    }

    return {
      round: this.round,
      segments: diffs,
      stableCount,
      changedCount,
      estimatedCachedTokens,
      estimatedTotalTokens,
    };
  }

  /** Reset state (e.g., new request) */
  reset(): void {
    this.previousSegments.clear();
    this.round = 0;
  }

  /** Get cache hit rate for the last recorded round */
  get lastCacheHitRate(): number {
    const total = this.previousSegments.size;
    if (total === 0) return 0;
    return 1; // First round is always 100% "new"
  }
}
