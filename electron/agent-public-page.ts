import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkFetch } from "./network";
import {
  assertGitHubRequestAllowed,
  githubRequestHeaders,
  githubResponseError,
  isGitHubUrl,
} from "./github-http";

export const decodeHtml = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

export const stripHtml = (value: string) =>
  decodeHtml(
    value
      .replace(
        /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

const privateAddress = (address: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(address) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address);

async function validatePublicUrl(input: string) {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("只允许公开 HTTP/HTTPS URL");
  if (
    ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())
  )
    throw new Error("禁止访问本机或内网地址");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => privateAddress(item.address))
  )
    throw new Error("禁止访问本机、内网或保留地址");
  return url;
}

type PublicPage = { url: string; contentType: string; text: string };

type CachedPublicPage = PublicPage & {
  etag: string;
  lastModified: string;
  expiresAt: number;
};

const publicPageCache = new Map<string, CachedPublicPage>();

const PUBLIC_PAGE_CACHE_TTL_MS = 60_000;

const PUBLIC_PAGE_CACHE_LIMIT = 24;

function rememberPublicPage(key: string, page: CachedPublicPage) {
  publicPageCache.delete(key);
  publicPageCache.set(key, page);
  while (publicPageCache.size > PUBLIC_PAGE_CACHE_LIMIT) {
    const oldest = publicPageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    publicPageCache.delete(oldest);
  }
}

export async function fetchPublic(
  input: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
) {
  let url = await validatePublicUrl(input);
  let timedOut = false;
  const controller = new AbortController(),
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const cacheKey = url.href;
      const cached = publicPageCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached;
      assertGitHubRequestAllowed(url);
      const headers = githubRequestHeaders(url, {
        "User-Agent": "Mozilla/5.0 KCode/1.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5",
      });
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      if (cached?.lastModified)
        headers.set("If-Modified-Since", cached.lastModified);
      const response = await networkFetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        url = await validatePublicUrl(
          new URL(response.headers.get("location")!, url).href,
        );
        continue;
      }
      if (response.status === 304 && cached) {
        const refreshed = {
          ...cached,
          expiresAt: Date.now() + PUBLIC_PAGE_CACHE_TTL_MS,
        };
        rememberPublicPage(cacheKey, refreshed);
        return refreshed;
      }
      if (!response.ok) {
        if (isGitHubUrl(url)) throw await githubResponseError(response, url);
        throw new Error(`网页请求失败 (${response.status})`);
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 2 * 1024 * 1024) throw new Error("网页响应超过 2 MB");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 2 * 1024 * 1024)
        throw new Error("网页响应超过 2 MB");
      const page = {
        url: url.href,
        contentType: response.headers.get("content-type") || "",
        text: new TextDecoder("utf-8").decode(bytes),
        etag: response.headers.get("etag") || "",
        lastModified: response.headers.get("last-modified") || "",
        expiresAt: Date.now() + PUBLIC_PAGE_CACHE_TTL_MS,
      };
      rememberPublicPage(cacheKey, page);
      return page;
    }
    throw new Error("网页重定向次数过多");
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal.aborted) throw new Error("任务已取消");
      if (timedOut)
        throw new Error(`网页读取超时（${Math.round(timeoutMs / 1_000)} 秒）`);
    }
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const details =
      cause && typeof cause === "object"
        ? (cause as { code?: string; message?: string })
        : undefined;
    const code = details?.code;
    const message =
      details?.message ||
      (error instanceof Error ? error.message : String(error));
    if (/fetch failed/i.test(message)) {
      const reason = code ? `${code}: ` : "";
      throw new Error(`网页连接失败（${reason}${message}）URL: ${url.href}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
