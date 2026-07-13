const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([\da-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => namedEntities[name] ?? match);
}

function htmlToText(value: string) {
  return decodeEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function releaseNotesText(value: unknown): string | undefined {
  const source = Array.isArray(value)
    ? value
        .map((item) =>
          item && typeof item === "object" && "note" in item
            ? String(item.note || "")
            : "",
        )
        .filter(Boolean)
        .join("\n\n")
    : typeof value === "string"
      ? value
      : "";
  const text = htmlToText(source);
  return text || undefined;
}
