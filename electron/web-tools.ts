import {
  decodeHtml,
  fetchPublic,
  stripHtml,
} from "./agent-public-page";
import type { ToolResult } from "./agent-types";

export type PublicPage = { url: string; contentType: string; text: string };

export type WebToolDeps = {
  fetchPublic: (input: string, signal: AbortSignal) => Promise<PublicPage>;
  stripHtml: (value: string) => string;
  decodeHtml: (value: string) => string;
};

const defaultWebToolDeps: WebToolDeps = {
  fetchPublic,
  stripHtml,
  decodeHtml,
};

function parseBingResults(
  text: string,
  limit: number,
  deps: WebToolDeps,
): { title: string; url: string; snippet: string }[] {
  return [
    ...text.matchAll(
      /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi,
    ),
  ]
    .slice(0, limit)
    .map((match) => ({
      title: deps.stripHtml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")),
      url: deps.decodeHtml(match[2].trim()),
      snippet: deps.stripHtml(match[3].replace(/^<!\[CDATA\[|\]\]>$/g, "")),
    }));
}

function parseDuckDuckGoResults(
  text: string,
  limit: number,
  deps: WebToolDeps,
): { title: string; url: string; snippet: string }[] {
  return [
    ...text.matchAll(
      /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ]
    .slice(0, limit)
    .map((match) => {
      const raw = deps.decodeHtml(match[1]);
      const redirected = /uddg=([^&]+)/.exec(raw);
      const url = redirected ? decodeURIComponent(redirected[1]) : raw;
      return {
        title: deps.stripHtml(match[2]),
        url,
        snippet: deps.stripHtml(match[3]),
      };
    });
}

export async function executeWebTool(
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  deps: WebToolDeps = defaultWebToolDeps,
): Promise<ToolResult> {
  if (name === "web_search") {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("缺少搜索关键词");
    const limit = Math.min(10, Math.max(1, Number(input.limit) || 5));
    const domain = String(input.domain || "").trim();
    const searchQuery = domain
      ? `${query} site:${domain.replace(/^https?:\/\//, "").split("/")[0]}`
      : query;
    let results: { title: string; url: string; snippet: string }[] = [];
    try {
      const page = await deps.fetchPublic(
        `https://www.bing.com/search?format=rss&q=${encodeURIComponent(searchQuery)}`,
        signal,
      );
      results = parseBingResults(page.text, limit, deps);
    } catch {
      const page = await deps.fetchPublic(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
        signal,
      );
      results = parseDuckDuckGoResults(page.text, limit, deps);
    }
    if (!results.length) throw new Error("搜索服务未返回结果");
    return { output: JSON.stringify({ query, results }, null, 2) };
  }
  if (name === "fetch_url") {
    const url = String(input.url || "").trim();
    if (!url) throw new Error("缺少网页 URL");
    const maxChars = Math.min(
      50_000,
      Math.max(1_000, Number(input.maxChars) || 20_000),
    );
    const page = await deps.fetchPublic(url, signal);
    if (!/text|html|xml|json/i.test(page.contentType))
      throw new Error(`不支持读取 ${page.contentType || "未知"} 类型`);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.text)?.[1];
    const content = /html/i.test(page.contentType)
      ? deps.stripHtml(page.text)
      : page.text.trim();
    return {
      output: JSON.stringify(
        {
          url: page.url,
          title: title ? deps.stripHtml(title) : undefined,
          content: content.slice(0, maxChars),
          truncated: content.length > maxChars,
        },
        null,
        2,
      ),
    };
  }
  throw new Error(`不支持的网页工具：${name}`);
}
