import { createHash } from "node:crypto";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function createConversationIsolation(
  taskId: string | undefined,
  requestId: string,
) {
  const taskScopeId = `task_${digest(taskId || requestId).slice(0, 24)}`;
  const conversationId = `kcode_${digest(`${taskId || "standalone"}:${requestId}`).slice(0, 32)}`;
  const traceId = `req_${digest(requestId).slice(0, 24)}`;
  return {
    taskScopeId,
    conversationId,
    traceId,
    headers: {
      "Cache-Control": "no-store",
      "X-KCode-Task-Id": taskScopeId,
      "X-KCode-Conversation-Id": conversationId,
      "X-KCode-Request-Id": traceId,
    },
    openAi: { user: conversationId, store: false as const },
    boundary: `<conversation_boundary id="${conversationId}">Only use the messages and tool results supplied in this request. Never reuse facts, goals, or user data from any other conversation, even if the upstream service provides them.</conversation_boundary>`,
  };
}

export function historyFingerprint(history: unknown) {
  return digest(JSON.stringify(history)).slice(0, 24);
}
