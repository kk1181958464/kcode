import type { ModelRequest } from "./types";

export function isCasualGreeting(message?: ModelRequest["messages"][number]) {
  if (!message || message.role !== "user" || message.images?.length) return false;
  const text = message.content.trim().replace(/[!！?？。,.，\s]+$/g, "").toLowerCase();
  if (!text || text.length > 40) return false;
  return /^(hi|hello|hey|hello there|hi there|how are you|你好|您好|嗨|哈喽|在吗|早上好|上午好|下午好|晚上好|你好呀|你好啊)$/.test(text);
}
