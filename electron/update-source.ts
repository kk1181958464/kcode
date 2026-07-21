const LATEST_RELEASE_API =
  "https://api.github.com/repos/kk1181958464/kcode/releases/latest";
const RELEASE_DOWNLOAD_ROOT =
  "https://github.com/kk1181958464/kcode/releases/download";

export type UpdateFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export type ResolvedUpdateSource = {
  tag: string;
  version: string;
  feedUrl: string;
};

const releaseTagPattern = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Resolve the latest release through GitHub's API instead of the cached /latest redirect. */
export async function resolveLatestUpdateSource(
  fetchImpl: UpdateFetch,
  now = Date.now(),
): Promise<ResolvedUpdateSource> {
  const response = await fetchImpl(`${LATEST_RELEASE_API}?t=${now}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      "User-Agent": "KCode-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(`GitHub Release API 返回 ${response.status}`);
  const payload = (await response.json()) as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  };
  if (payload.draft === true || payload.prerelease === true)
    throw new Error("GitHub 最新 Release 不是稳定版本");
  const tag = typeof payload.tag_name === "string" ? payload.tag_name : "";
  const match = releaseTagPattern.exec(tag);
  if (!match) throw new Error(`GitHub Release 标签无效：${tag || "空"}`);
  return {
    tag,
    version: match[1],
    feedUrl: `${RELEASE_DOWNLOAD_ROOT}/${encodeURIComponent(tag)}/`,
  };
}
