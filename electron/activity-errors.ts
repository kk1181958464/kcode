export function conciseFailureOutput(value: string, maxLength = 280) {
  const sanitized = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      "[私钥已隐藏]",
    )
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[已隐藏]")
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
      "$1=[已隐藏]",
    );
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
