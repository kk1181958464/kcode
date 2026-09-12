import type { PendingUserInput, ToolCall } from "./agent-types";

const SECRET_INPUT_KEY =
  /(?:password|passphrase|privateKey|sslKey|secret|token)$/i;

export function redactedToolInput(call: ToolCall) {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.input)) {
    if (call.name === "browser_type" && key === "text") {
      input[key] = value ? "[已安全隐藏]" : value;
      continue;
    }
    if (SECRET_INPUT_KEY.test(key)) {
      input[key] = value ? "[已安全隐藏]" : value;
      continue;
    }
    if (key === "uri" && typeof value === "string") {
      input[key] = value.replace(
        /^(mongodb(?:\+srv)?:\/\/)([^/@]+)@/i,
        "$1[已隐藏]@",
      );
      continue;
    }
    input[key] = value;
  }
  return input;
}

export function normalizePendingUserInput(
  input: Record<string, unknown>,
): PendingUserInput | undefined {
  const question = String(input.question || "")
    .replace(/\s+/g, " ")
    .trim();
  const fields = Array.isArray(input.fields)
    ? input.fields
        .map((field) => String(field).replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];
  if (question.length < 8 || !fields.length) return undefined;
  return { question, fields };
}

export function pendingUserInputMessage(input: PendingUserInput) {
  return [
    "需要你补充以下信息后才能继续：",
    "",
    input.question,
    "",
    "请提供：",
    ...input.fields.map((field) => `- ${field}`),
  ].join("\n");
}
