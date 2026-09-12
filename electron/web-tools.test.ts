import assert from "node:assert/strict";
import test from "node:test";
import { executeWebTool, type PublicPage, type WebToolDeps } from "./web-tools";

const passthrough: Pick<WebToolDeps, "stripHtml" | "decodeHtml"> = {
  stripHtml: (value) =>
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  decodeHtml: (value) => value.replace(/&amp;/g, "&"),
};

test("web_search parses Bing RSS and keeps the original query", async () => {
  const result = await executeWebTool(
    "web_search",
    { query: "kcode", limit: 1 },
    new AbortController().signal,
    {
      ...passthrough,
      async fetchPublic() {
        return {
          url: "https://www.bing.com/search",
          contentType: "application/rss+xml",
          text: "<item><title>KCode</title><link>https://example.com</link><description>desktop agent</description></item>",
        };
      },
    },
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.query, "kcode");
  assert.deepEqual(parsed.results, [
    { title: "KCode", url: "https://example.com", snippet: "desktop agent" },
  ]);
});

test("web_search scopes a domain and falls back to DuckDuckGo", async () => {
  const urls: string[] = [];
  const result = await executeWebTool(
    "web_search",
    { query: "agent", domain: "https://docs.example.com/path", limit: 1 },
    new AbortController().signal,
    {
      ...passthrough,
      async fetchPublic(input) {
        urls.push(input);
        if (input.includes("bing.com")) throw new Error("bing down");
        return {
          url: input,
          contentType: "text/html",
          text: '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fagent">Docs</a><a class="result__snippet">guide</a>',
        };
      },
    },
  );
  assert.match(urls[0] ?? "", /q=agent%20site%3Adocs.example.com/);
  assert.match(urls[1] ?? "", /duckduckgo/);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.results[0].url, "https://docs.example.com/agent");
  assert.equal(parsed.results[0].title, "Docs");
});

test("web_search rejects empty queries and empty result pages", async () => {
  await assert.rejects(
    () => executeWebTool("web_search", { query: "  " }, new AbortController().signal),
    /缺少搜索关键词/,
  );
  await assert.rejects(
    () =>
      executeWebTool(
        "web_search",
        { query: "none" },
        new AbortController().signal,
        {
          ...passthrough,
          async fetchPublic(): Promise<PublicPage> {
            return { url: "https://bing", contentType: "text/xml", text: "<rss/>" };
          },
        },
      ),
    /搜索服务未返回结果/,
  );
});

test("fetch_url strips HTML and truncates content", async () => {
  const result = await executeWebTool(
    "fetch_url",
    { url: "https://example.com", maxChars: 1000 },
    new AbortController().signal,
    {
      ...passthrough,
      async fetchPublic() {
        return {
          url: "https://example.com/page",
          contentType: "text/html",
          text: "<title>Example</title><p>hello world</p>",
        };
      },
    },
  );
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.url, "https://example.com/page");
  assert.equal(parsed.title, "Example");
  assert.equal(parsed.content, "Example hello world");
  assert.equal(parsed.truncated, false);
});

test("fetch_url rejects missing urls and unsupported content types", async () => {
  await assert.rejects(
    () => executeWebTool("fetch_url", {}, new AbortController().signal),
    /缺少网页 URL/,
  );
  await assert.rejects(
    () =>
      executeWebTool(
        "fetch_url",
        { url: "https://example.com/a.png" },
        new AbortController().signal,
        {
          ...passthrough,
          async fetchPublic() {
            return {
              url: "https://example.com/a.png",
              contentType: "image/png",
              text: "",
            };
          },
        },
      ),
    /不支持读取 image\/png/,
  );
});
