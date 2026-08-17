/**
 * Handoff Summary: model-driven context compaction using cheap models.
 *
 * Maps each provider to its cheapest available model for summarization,
 * and provides an enhanced handoff prompt that produces structured,
 * high-quality context summaries.
 */

/**
 * Map of provider protocols/families to their cheapest summarization model.
 * Used to avoid burning expensive tokens on context compression.
 */
export const CHEAP_MODEL_MAP: Record<string, string> = {
  // Anthropic
  "anthropic-messages": "claude-haiku-4-20250414",
  // OpenAI
  "openai-chat": "gpt-4o-mini",
  "openai-responses": "gpt-4o-mini",
  // Google
  "gemini-generate-content": "gemini-2.0-flash",
};

/**
 * Select the cheapest available model for a given provider protocol.
 * Falls back to the task model if no cheap alternative is known.
 */
export function selectCheapModel(
  protocol: string,
  taskModelId: string,
): string {
  return CHEAP_MODEL_MAP[protocol] ?? taskModelId;
}

/**
 * Enhanced handoff prompt that produces better structured summaries.
 * Key improvements over the baseline:
 * - Explicitly separates verified facts from unverified claims
 * - Preserves file paths with line numbers when available
 * - Tracks architectural decisions with rationale
 * - Maintains a "next steps" section for seamless continuation
 */
export const HANDOFF_SYSTEM_PROMPT = `You are a context-compression specialist for a coding assistant. Your job is to create a structured handoff summary that allows a fresh model instance to continue the task seamlessly.

Output JSON with this exact shape:
{
  "summary": "<markdown string>",
  "ledger": {
    "goals": ["<concise user goals>"],
    "decisions": ["<architectural decisions with rationale>"],
    "pending": ["<work not yet completed>"]
  }
}

Rules for the summary markdown:
1. Start with "## Current Objective" — what the user wants, in one sentence
2. "## Progress" — bullet list of completed work with file paths
3. "## Key Decisions" — architectural choices and constraints still in effect
4. "## Active Context" — variables, patterns, or state the next model needs
5. "## Next Steps" — ordered list of what to do next
6. "## Failures & Risks" — unresolved issues, failed approaches to avoid

Rules for accuracy:
- Only report tool results as facts (changed files, test outcomes, command outputs)
- Mark model-only claims (no tool evidence) as "[unverified]"
- Do not create or rewrite changedFiles, validations, failures, or connections; those fields are maintained by the runtime event ledger
- Later facts override earlier contradictions
- Never include passwords, tokens, private keys, or auth headers
- Preserve connection coordinates (host, port, user, database) without secrets
- Keep total summary under 3000 tokens
- Remove redundant context that won't help continuation`;

/**
 * Context compaction thresholds.
 * These define when different levels of compaction kick in.
 */
export const COMPACTION_THRESHOLDS = {
  /** First compaction: rule-based summary of older messages */
  INITIAL: 0.75,
  /** Model-enhanced: use cheap model to improve summary quality */
  MODEL_ENHANCED: 0.85,
  /** Aggressive: re-compact including previous summary */
  AGGRESSIVE: 0.92,
  /** Emergency: hard truncation fallback */
  EMERGENCY: 0.99,
} as const;
