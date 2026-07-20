export function conciseFailureOutput(value: string, maxLength = 280) {
  const sanitized = value.replace(/\u001b\[[0-9;]*m/g, "");
  const stderr = sanitized.includes("stderr:\n")
    ? sanitized.slice(sanitized.lastIndexOf("stderr:\n") + 8)
    : sanitized;
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("signal:"))
    .at(-1);
  if (!detail) return "";
  return detail.length > maxLength
    ? `${detail.slice(0, maxLength - 1)}…`
    : detail;
}
