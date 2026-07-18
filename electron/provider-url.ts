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