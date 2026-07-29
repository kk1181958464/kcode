import type { ChatMessage } from "./types";

export type ConversationWindow = { start: number; end: number };

export type ConversationTurn = {
  id: string;
  question: string;
  answer: string;
  messageIndex: number;
};

function previewText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function conversationTurnPreviews(
  messages: readonly ChatMessage[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    let assistant: ChatMessage | undefined;
    for (let next = index + 1; next < messages.length; next += 1) {
      if (messages[next].role === "user") break;
      if (messages[next].role === "assistant") {
        assistant = messages[next];
        break;
      }
    }
    const queued = Boolean(
      (message as ChatMessage & { queued?: boolean }).queued,
    );
    turns.push({
      id: message.id,
      question: previewText(message.content, 120),
      answer:
        previewText(assistant?.content || assistant?.error || "", 220) ||
        (queued ? "消息已排队，等待上一轮完成" : "此轮正在等待回复"),
      messageIndex: index,
    });
  }
  return turns;
}

export function latestConversationWindow(
  turnCount: number,
  pageSize: number,
): ConversationWindow {
  const size = Math.max(1, pageSize);
  return { start: Math.max(0, turnCount - size), end: turnCount };
}

export function prependConversationWindow(
  current: ConversationWindow,
  pageSize: number,
): ConversationWindow {
  const size = Math.max(1, pageSize);
  const start = Math.max(0, current.start - size);
  return { start, end: Math.min(current.end, start + size * 2) };
}

export function appendConversationWindow(
  current: ConversationWindow,
  turnCount: number,
  pageSize: number,
): ConversationWindow {
  const size = Math.max(1, pageSize);
  const end = Math.min(turnCount, current.end + size);
  return { start: Math.max(0, end - size * 2), end };
}

export function windowContainingTurn(
  index: number,
  turnCount: number,
  pageSize: number,
): ConversationWindow {
  const size = Math.max(1, pageSize);
  const start = Math.max(0, Math.min(index, turnCount - size));
  return { start, end: Math.min(turnCount, start + size * 2) };
}
