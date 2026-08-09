/**
 * History Normalization Pipeline — clean up conversation history before
 * sending to the model. Ensures structural validity, removes redundancy,
 * and keeps the history lean.
 *
 * Inspired by Codex CLI's history management that normalizes conversation
 * state after retries, interruptions, and synthetic injections.
 */

import { isSyntheticId } from "./synthetic-id";

/**
 * Mirrors the HistoryItem type from agent.ts.
 * Defined here to avoid circular imports.
 */
type HistoryItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      content: string;
      reasoningContent?: string;
      images?: unknown[];
    }
  | { kind: "calls"; calls: Array<{ id: string; name: string; input: unknown }>; rawCalls: unknown[] }
  | { kind: "result"; callId: string; content: string };

export interface NormalizeOptions {
  /** Maximum number of synthetic injection messages to keep. Default: 5 */
  maxSyntheticInjections?: number;
  /** Whether to merge consecutive same-role messages. Default: true */
  mergeConsecutive?: boolean;
  /** Whether to deduplicate tool results with same callId. Default: true */
  deduplicateResults?: boolean;
  /** Whether to prune orphan results (no matching call). Default: true */
  pruneOrphans?: boolean;
  /** Maximum number of tool_execution_record injections to keep. Default: 3 */
  maxExecutionRecords?: number;
}

const DEFAULT_OPTIONS: Required<NormalizeOptions> = {
  maxSyntheticInjections: 5,
  mergeConsecutive: true,
  deduplicateResults: true,
  pruneOrphans: true,
  maxExecutionRecords: 3,
};

/**
 * Run the full normalization pipeline on history.
 * Returns a new array (does not mutate input).
 * Uses the local HistoryItem type — callers with richer types should cast.
 */
export function normalizeHistory(
  history: HistoryItem[],
  options?: NormalizeOptions,
): HistoryItem[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = [...history];

  // Step 1: Deduplicate tool results with same callId (keeps last)
  if (opts.deduplicateResults) {
    result = deduplicateToolResults(result);
  }

  // Step 2: Prune orphan results (result without a matching call)
  if (opts.pruneOrphans) {
    result = pruneOrphanResults(result);
  }

  // Step 3: Merge consecutive same-role messages
  if (opts.mergeConsecutive) {
    result = mergeConsecutiveMessages(result);
  }

  // Step 4: Trim old synthetic injections (keep only recent ones)
  result = trimSyntheticInjections(result, opts.maxSyntheticInjections);

  // Step 5: Trim old execution records (keep only recent ones)
  result = trimExecutionRecords(result, opts.maxExecutionRecords);

  return result;
}

/**
 * Remove duplicate tool results (same callId). When retries occur,
 * the same callId may appear multiple times. Keep the last occurrence.
 */
function deduplicateToolResults(history: HistoryItem[]): HistoryItem[] {
  // Find all callIds and their last occurrence index
  const lastOccurrence = new Map<string, number>();
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.kind === "result") {
      lastOccurrence.set(item.callId, i);
    }
  }

  // Keep only the last occurrence of each callId
  return history.filter((item, index) => {
    if (item.kind !== "result") return true;
    return lastOccurrence.get(item.callId) === index;
  });
}

/**
 * Remove result items that have no matching call in the history.
 * This can happen after retries or history truncation.
 * Synthetic IDs are exempt — they're injections, not model-generated.
 */
function pruneOrphanResults(history: HistoryItem[]): HistoryItem[] {
  // Collect all known call IDs
  const knownCallIds = new Set<string>();
  for (const item of history) {
    if (item.kind === "calls") {
      for (const call of item.calls) {
        knownCallIds.add(call.id);
      }
    }
  }

  return history.filter((item) => {
    if (item.kind !== "result") return true;
    // Synthetic results are always kept (they're injections)
    if (isSyntheticId(item.callId)) return true;
    // Keep results that have a matching call
    return knownCallIds.has(item.callId);
  });
}

/**
 * Merge consecutive messages of the same role into one.
 * This reduces token overhead from multiple back-to-back user or assistant messages.
 * Does NOT merge messages that contain images (preserving multimodal context).
 */
function mergeConsecutiveMessages(history: HistoryItem[]): HistoryItem[] {
  if (history.length <= 1) return history;

  const result: HistoryItem[] = [];
  for (const item of history) {
    const prev = result[result.length - 1];
    if (
      item.kind === "message" &&
      prev?.kind === "message" &&
      item.role === prev.role &&
      !item.images?.length &&
      !prev.images?.length
    ) {
      // Merge into previous
      result[result.length - 1] = {
        ...prev,
        content: prev.content + "\n" + item.content,
        reasoningContent: mergeOptionalStrings(
          prev.reasoningContent,
          item.reasoningContent,
        ),
      };
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Trim old synthetic injection messages, keeping only the most recent N.
 * Synthetic injections are user messages with tags like <tool_execution_record>,
 * <stop_hook_feedback>, etc.
 */
function trimSyntheticInjections(
  history: HistoryItem[],
  maxKeep: number,
): HistoryItem[] {
  const INJECTION_PATTERNS = [
    /<stop_hook_feedback>/,
    /<runtime_verification>/,
  ];

  // Find indices of synthetic injection messages
  const injectionIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (
      item.kind === "message" &&
      item.role === "user" &&
      INJECTION_PATTERNS.some((p) => p.test(item.content))
    ) {
      injectionIndices.push(i);
    }
  }

  // If within limit, no trimming needed
  if (injectionIndices.length <= maxKeep) return history;

  // Remove oldest injections (keep the last maxKeep)
  const toRemove = new Set(injectionIndices.slice(0, -maxKeep));
  return history.filter((_, index) => !toRemove.has(index));
}

/**
 * Trim old tool execution record messages, keeping only the most recent N.
 */
function trimExecutionRecords(
  history: HistoryItem[],
  maxKeep: number,
): HistoryItem[] {
  const recordIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (
      item.kind === "message" &&
      item.role === "user" &&
      item.content.includes("<tool_execution_record>")
    ) {
      recordIndices.push(i);
    }
  }

  if (recordIndices.length <= maxKeep) return history;

  const toRemove = new Set(recordIndices.slice(0, -maxKeep));
  return history.filter((_, index) => !toRemove.has(index));
}

/**
 * Merge two optional strings (for reasoningContent).
 */
function mergeOptionalStrings(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return a + "\n" + b;
}

/**
 * Validate history structural integrity.
 * Returns issues found (empty array = valid).
 * Does NOT fix — use normalizeHistory for that.
 */
export function validateHistory(history: HistoryItem[]): string[] {
  const issues: string[] = [];
  const declaredCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.kind === "calls") {
      for (const call of item.calls) {
        if (declaredCallIds.has(call.id)) {
          issues.push(`Duplicate call ID: ${call.id} at index ${i}`);
        }
        declaredCallIds.add(call.id);
      }
    } else if (item.kind === "result") {
      if (!isSyntheticId(item.callId) && !declaredCallIds.has(item.callId)) {
        issues.push(`Orphan result for callId: ${item.callId} at index ${i}`);
      }
      if (answeredCallIds.has(item.callId)) {
        issues.push(`Duplicate result for callId: ${item.callId} at index ${i}`);
      }
      answeredCallIds.add(item.callId);
    }
  }

  // Check for unanswered calls
  for (const callId of declaredCallIds) {
    if (!answeredCallIds.has(callId)) {
      issues.push(`Unanswered call: ${callId}`);
    }
  }

  return issues;
}
