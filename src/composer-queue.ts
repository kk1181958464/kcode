import type { ChatMessage } from "./types";

export type ComposerSubmitAction = "send" | "queue" | "send-immediate";

/** Decide what Enter / modifier+Enter should do in the composer. */
export function resolveComposerSubmitAction(options: {
  running: boolean;
  immediate: boolean;
}): ComposerSubmitAction {
  if (options.immediate) return "send-immediate";
  if (options.running) return "queue";
  return "send";
}

/** Classify a composer keydown for submit (Enter) vs newline (Shift+Enter). */
export function classifyComposerEnterKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): "none" | "submit" | "submit-immediate" {
  if (event.isComposing || event.keyCode === 229) return "none";
  if (event.key !== "Enter" || event.shiftKey) return "none";
  if (event.ctrlKey || event.metaKey) return "submit-immediate";
  return "submit";
}

/** Move a queued user message to the front of the send queue (after settled turns). */
export function prioritizeQueuedInMessages(
  all: ChatMessage[],
  messageId: string,
): ChatMessage[] {
  const item = all.find((message) => message.id === messageId);
  if (!item) return all;
  const isQueuedUser = (message: ChatMessage) =>
    message.role === "user" &&
    Boolean((message as ChatMessage & { queued?: boolean }).queued);
  return [
    ...all.filter(
      (message) => message.id !== messageId && !isQueuedUser(message),
    ),
    item,
    ...all.filter(
      (message) => message.id !== messageId && isQueuedUser(message),
    ),
  ];
}

/** Shortcut label matching existing Ctrl/⌘ app conventions. */
export function composerModifierKeyLabel(
  platform = typeof navigator !== "undefined"
    ? navigator.platform || navigator.userAgent || ""
    : "",
): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}
