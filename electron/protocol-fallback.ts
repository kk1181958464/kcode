import type { Protocol } from "../src/types";

const FALLBACK_TTL_MS = 30 * 60_000;
const chatFallbackUntil = new Map<string, number>();

export function shouldFallbackResponses(
  baseUrl: string,
  status: number,
  errorText = "",
) {
  if (/^https:\/\/api\.openai\.com(?:\/|$)/i.test(baseUrl)) return false;
  if ([404, 405, 501, 502, 503, 504].includes(status)) return true;
  if (status !== 400 && status !== 422) return false;

  // Several OpenAI-compatible relays expose /responses but cannot continue a
  // tool round from function_call + function_call_output history. They return
  // a validation error instead of 404/501. Only downgrade for an explicit
  // Responses item-reference/tool-history incompatibility; ordinary bad
  // parameters, authentication and rate limits must keep their real error.
  const message = errorText.toLowerCase();
  return (
    message.includes("function_call_output") &&
    /item[_ -]?reference|call[_ -]?id|function[_ -]?call|previous_response_id|not (?:found|supported)|unknown/.test(
      message,
    )
  );
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

export function rememberChatFallback(providerId: string, now = Date.now()) {
  chatFallbackUntil.set(providerId, now + FALLBACK_TTL_MS);
}

export function clearProtocolFallbacks() {
  chatFallbackUntil.clear();
}
