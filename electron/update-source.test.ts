import assert from "node:assert/strict";
import test from "node:test";
import { resolveLatestUpdateSource } from "./update-source";

test("resolves a stable GitHub release to a fixed, cache-safe feed", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const source = await resolveLatestUpdateSource(
    async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.2.22",
          draft: false,
          prerelease: false,
        }),
      };
    },
    1234,
  );

  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/kk1181958464/kcode/releases/latest?t=1234",
  );
  assert.equal(requestedInit?.cache, "no-store");
  assert.match(
    String((requestedInit?.headers as Record<string, string>)["Cache-Control"]),
    /no-cache/,
  );
  assert.deepEqual(source, {
    tag: "v0.2.22",
    version: "0.2.22",
    feedUrl:
      "https://github.com/kk1181958464/kcode/releases/download/v0.2.22/",
  });
});

test("rejects invalid or non-stable release metadata", async () => {
  await assert.rejects(
    resolveLatestUpdateSource(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: "nightly", draft: false }),
    })),
    /标签无效/,
  );
  await assert.rejects(
    resolveLatestUpdateSource(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: "v0.2.23-beta.1", prerelease: true }),
    })),
    /不是稳定版本/,
  );
});

test("reports GitHub API failures", async () => {
  await assert.rejects(
    resolveLatestUpdateSource(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })),
    /503/,
  );
});
