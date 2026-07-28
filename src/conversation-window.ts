export type ConversationWindow = { start: number; end: number };

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