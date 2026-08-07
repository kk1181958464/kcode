import type { Protocol } from "../src/types";

export function validateProviderBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Base URL 格式无效");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
  }
  if (!url.hostname) throw new Error("Base URL 缺少主机地址");
  if (url.username || url.password) {
    throw new Error("Base URL 不能包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw new Error("Base URL 不能包含查询参数或片段");
  }

  return url;
}

const API_RESOURCE_SUFFIXES = [
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/responses",
  "/responses",
  "/v1/messages",
  "/messages",
  "/v1beta/models",
  "/v1/models",
  "/models",
] as const;

/**
 * Keep custom gateway prefixes (for example /api or /openai) while removing
 * standard API versions/resources that users commonly paste into Base URL.
 */
export function normalizeProviderBaseUrl(value: string, _protocol: Protocol) {
  const url = validateProviderBaseUrl(value);
  let pathname = url.pathname.replace(/\/+$/, "");
  const lower = pathname.toLowerCase();
  const resource = API_RESOURCE_SUFFIXES.find((suffix) =>
    lower.endsWith(suffix),
  );
  if (resource) pathname = pathname.slice(0, -resource.length);
  pathname = pathname.replace(/\/(?:v1beta|v1)$/i, "").replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function providerApiEndpoint(
  baseUrl: string,
  protocol: Protocol,
  resource: string,
) {
  const root = normalizeProviderBaseUrl(baseUrl, protocol);
  const version = protocol === "gemini-generate-content" ? "v1beta" : "v1";
  return `${root}/${version}/${resource.replace(/^\/+/, "")}`;
}
