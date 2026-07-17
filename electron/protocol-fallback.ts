import type { Protocol } from "../src/types";

const FALLBACK_TTL_MS = 30 * 60_000;
const chatFallbackUntil = new Map<string, number>();

export function shouldFallbackResponses(
  baseUrl: string,
  status: number,
) {
  if (/^https:\/\/api\.openai\.com(?:\/|$)/i.test(baseUrl)) return false;
  return [404, 405, 501, 502, 503, 504].includes(status);
}

export function effectiveOpenAiProtocol(
  providerId: string,
  configured: Protocol,
  now = Date.now(),
): Protocol {
  if (configured !== "openai-responses") return configured;
  const until = chatFallbackUntil.get(providerId) ?? 0;
  if (until > now) return "openai-chat";
  chatFallbackUntil.delete(providerId);
  return configured;
}

export function rememberChatFallback(
  providerId: string,
  now = Date.now(),
) {
  chatFallbackUntil.set(providerId, now + FALLBACK_TTL_MS);
}

export function clearProtocolFallbacks() {
  chatFallbackUntil.clear();
}