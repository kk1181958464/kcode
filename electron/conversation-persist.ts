/**
 * Conversation Persistence — append-only JSONL format for storing conversation
 * events. Supports resuming from any point and replaying history.
 *
 * Inspired by Claude Code's conversation persistence that allows session
 * continuity across restarts.
 *
 * Storage: `<userData>/conversations/<requestId>.jsonl`
 * Each line is a JSON object representing a conversation event.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConversationEventType =
  | "session_start"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "system_injection"
  | "compact"
  | "error"
  | "session_end";

export interface ConversationEvent {
  /** Event type */
  type: ConversationEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Monotonic sequence number within session */
  seq: number;
  /** Request/session ID */
  requestId: string;
  /** Event payload */
  data: Record<string, unknown>;
}

export interface SessionMetadata {
  /** Request ID */
  requestId: string;
  /** Workspace root */
  workspaceRoot: string;
  /** Model used */
  model: string;
  /** Provider */
  provider: string;
  /** Start time */
  startedAt: string;
  /** Task ID if applicable */
  taskId?: string;
  /** Number of events recorded */
  eventCount: number;
  /** Last event timestamp */
  lastEventAt: string;
}

// ─── Conversation Writer ─────────────────────────────────────────────────────

/**
 * Append-only writer for conversation events.
 */
export class ConversationWriter {
  private filePath: string;
  private fd: number | null = null;
  private seq = 0;
  private eventCount = 0;
  private lastEventAt = "";

  constructor(
    private requestId: string,
    private workspaceRoot: string,
    private model: string,
    private provider: string,
    private taskId?: string,
  ) {
    const dir = conversationsDir();
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${requestId}.jsonl`);
  }

  /**
   * Write a session_start event. Call once at the beginning.
   */
  start(): void {
    this.append({
      type: "session_start",
      data: {
        workspaceRoot: this.workspaceRoot,
        model: this.model,
        provider: this.provider,
        taskId: this.taskId,
      },
    });
  }

  /**
   * Record a user message.
   */
  userMessage(content: string): void {
    this.append({
      type: "user_message",
      data: { content: truncateForPersist(content) },
    });
  }

  /**
   * Record an assistant message (model response text).
   */
  assistantMessage(content: string): void {
    this.append({
      type: "assistant_message",
      data: { content: truncateForPersist(content) },
    });
  }

  /**
   * Record a tool call.
   */
  toolCall(callId: string, toolName: string, input: unknown): void {
    this.append({
      type: "tool_call",
      data: {
        callId,
        toolName,
        input: truncateInput(input),
      },
    });
  }

  /**
   * Record a tool result.
   */
  toolResult(callId: string, toolName: string, success: boolean, output?: string): void {
    this.append({
      type: "tool_result",
      data: {
        callId,
        toolName,
        success,
        output: output ? output.slice(0, 5000) : undefined,
      },
    });
  }

  /**
   * Record a system injection (context compression, hook output, etc.).
   */
  systemInjection(source: string, content: string): void {
    this.append({
      type: "system_injection",
      data: { source, content: content.slice(0, 2000) },
    });
  }

  /**
   * Record a compaction event.
   */
  compact(reason: string, removedTokens: number, keptTokens: number): void {
    this.append({
      type: "compact",
      data: { reason, removedTokens, keptTokens },
    });
  }

  /**
   * Record an error event.
   */
  error(message: string, code?: string): void {
    this.append({
      type: "error",
      data: { message: message.slice(0, 1000), code },
    });
  }

  /**
   * Close the session.
   */
  end(reason: "complete" | "aborted" | "error" = "complete"): void {
    this.append({
      type: "session_end",
      data: { reason, totalEvents: this.eventCount },
    });
    this.close();
  }

  /**
   * Get the file path for this conversation log.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Close the file descriptor.
   */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Best effort
      }
      this.fd = null;
    }
  }

  private append(event: Omit<ConversationEvent, "timestamp" | "seq" | "requestId">): void {
    const now = new Date().toISOString();
    const fullEvent: ConversationEvent = {
      ...event,
      timestamp: now,
      seq: this.seq++,
      requestId: this.requestId,
    };

    const line = JSON.stringify(fullEvent) + "\n";

    try {
      if (this.fd === null) {
        this.fd = fs.openSync(this.filePath, "a");
      }
      fs.writeSync(this.fd, line);
      this.eventCount++;
      this.lastEventAt = now;
    } catch {
      // Non-critical — don't crash the agent for persistence failures
    }
  }
}

// ─── Conversation Reader ─────────────────────────────────────────────────────

/**
 * Read and replay a persisted conversation.
 */
export class ConversationReader {
  private filePath: string;

  constructor(requestId: string) {
    this.filePath = path.join(conversationsDir(), `${requestId}.jsonl`);
  }

  /**
   * Check if this conversation exists on disk.
   */
  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * Read all events from the conversation file.
   */
  readAll(): ConversationEvent[] {
    if (!this.exists()) return [];

    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as ConversationEvent);
    } catch {
      return [];
    }
  }

  /**
   * Read events after a given sequence number (for incremental resume).
   */
  readAfter(seq: number): ConversationEvent[] {
    return this.readAll().filter((e) => e.seq > seq);
  }

  /**
   * Get session metadata from the conversation file.
   */
  getMetadata(): SessionMetadata | null {
    const events = this.readAll();
    if (!events.length) return null;

    const startEvent = events.find((e) => e.type === "session_start");
    if (!startEvent) return null;

    const lastEvent = events[events.length - 1];

    return {
      requestId: startEvent.requestId,
      workspaceRoot: String(startEvent.data.workspaceRoot || ""),
      model: String(startEvent.data.model || ""),
      provider: String(startEvent.data.provider || ""),
      startedAt: startEvent.timestamp,
      taskId: startEvent.data.taskId as string | undefined,
      eventCount: events.length,
      lastEventAt: lastEvent.timestamp,
    };
  }

  /**
   * Reconstruct message history from persisted events.
   * Returns a simplified history suitable for resuming a conversation.
   */
  reconstructHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    const events = this.readAll();
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const event of events) {
      if (event.type === "user_message") {
        messages.push({
          role: "user",
          content: String(event.data.content || ""),
        });
      } else if (event.type === "assistant_message") {
        messages.push({
          role: "assistant",
          content: String(event.data.content || ""),
        });
      }
    }

    return messages;
  }
}

// ─── Session Listing ─────────────────────────────────────────────────────────

/**
 * List all persisted conversation sessions.
 */
export function listSessions(): SessionMetadata[] {
  const dir = conversationsDir();
  if (!fs.existsSync(dir)) return [];

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const sessions: SessionMetadata[] = [];

    for (const file of files) {
      const requestId = file.replace(".jsonl", "");
      const reader = new ConversationReader(requestId);
      const meta = reader.getMetadata();
      if (meta) sessions.push(meta);
    }

    // Sort by most recent first
    sessions.sort(
      (a, b) =>
        new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime(),
    );

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Clean up old conversation files.
 */
export function cleanupConversations(maxAgeDays = 30): number {
  const dir = conversationsDir();
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Directory read failed
  }

  return removed;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function conversationsDir(): string {
  return path.join(app.getPath("userData"), "conversations");
}

/** Truncate large content for persistence (keep first + last). */
function truncateForPersist(content: string, maxLen = 10_000): string {
  if (content.length <= maxLen) return content;
  const half = Math.floor(maxLen / 2);
  return (
    content.slice(0, half) +
    `\n\n[...truncated ${content.length - maxLen} chars...]\n\n` +
    content.slice(-half)
  );
}

/** Truncate tool input for persistence. */
function truncateInput(input: unknown): unknown {
  if (typeof input === "string") return truncateForPersist(input, 5000);
  if (typeof input !== "object" || input === null) return input;

  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.length > 5000) {
      result[key] = value.slice(0, 5000) + "...[truncated]";
    } else {
      result[key] = value;
    }
  }
  return result;
}
