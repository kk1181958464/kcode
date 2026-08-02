type HeaderSource =
  Pick<Headers, "get"> | Record<string, string | undefined> | undefined;

export type GitHubResponseLike = {
  status: number;
  headers?: HeaderSource;
  text?: () => Promise<string>;
};

const GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
]);
const DEFAULT_FORBIDDEN_COOLDOWN_MS = 60_000;
const cooldowns = new Map<string, number>();

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAt?: number,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

export function isGitHubUrl(input: string | URL) {
  try {
    return GITHUB_HOSTS.has(
      (input instanceof URL ? input : new URL(input)).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function headerValue(headers: HeaderSource, name: string) {
  if (!headers) return "";
  if ("get" in headers && typeof headers.get === "function")
    return headers.get(name) || "";
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? record[key] || "" : "";
}

function retryAfterTimestamp(value: string, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return now + Math.max(1, seconds) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp : undefined;
}

function resetTimestamp(value: string, now: number) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const timestamp = seconds * 1_000;
  return timestamp > now ? timestamp : undefined;
}

function retryTimeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rememberCooldown(host: string, retryAt: number) {
  cooldowns.set(host, Math.max(cooldowns.get(host) || 0, retryAt));
}

export function assertGitHubRequestAllowed(
  input: string | URL,
  now = Date.now(),
) {
  const url = input instanceof URL ? input : new URL(input);
  if (!isGitHubUrl(url)) return;
  const retryAt = cooldowns.get(url.hostname.toLowerCase()) || 0;
  if (retryAt <= now) {
    cooldowns.delete(url.hostname.toLowerCase());
    return;
  }
  throw new GitHubRequestError(
    `GitHub 请求暂时受限，已暂停重复访问，将在 ${retryTimeLabel(retryAt)} 后恢复`,
    403,
    retryAt,
    true,
  );
}

export function githubRequestHeaders(
  input: string | URL,
  initial?: HeadersInit,
) {
  const url = input instanceof URL ? input : new URL(input);
  const headers = new Headers(initial);
  if (!isGitHubUrl(url)) return headers;
  if (!headers.has("User-Agent")) headers.set("User-Agent", "KCode/1.0");
  if (url.hostname.toLowerCase() === "api.github.com") {
    if (!headers.has("Accept"))
      headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function responseDetail(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.trim();
  } catch {
    // HTML and plain-text failures are handled below.
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 180);
}

export async function githubResponseError(
  response: GitHubResponseLike,
  input: string | URL,
  now = Date.now(),
) {
  const url = input instanceof URL ? input : new URL(input);
  let body = "";
  try {
    body = response.text ? await response.text() : "";
  } catch {
    body = "";
  }
  const detail = responseDetail(body);
  const remaining = headerValue(response.headers, "x-ratelimit-remaining");
  const retryAt =
    retryAfterTimestamp(headerValue(response.headers, "retry-after"), now) ||
    resetTimestamp(headerValue(response.headers, "x-ratelimit-reset"), now);
  const rateLimited =
    response.status === 429 ||
    remaining === "0" ||
    /rate limit|secondary rate|abuse detection/i.test(detail);

  if (rateLimited) {
    const effectiveRetryAt = retryAt || now + DEFAULT_FORBIDDEN_COOLDOWN_MS;
    rememberCooldown(url.hostname.toLowerCase(), effectiveRetryAt);
    return new GitHubRequestError(
      `GitHub API 请求额度已用尽，将在 ${retryTimeLabel(effectiveRetryAt)} 后恢复（HTTP ${response.status}）`,
      response.status,
      effectiveRetryAt,
      true,
    );
  }

  if (response.status === 403) {
    const effectiveRetryAt = retryAt || now + DEFAULT_FORBIDDEN_COOLDOWN_MS;
    rememberCooldown(url.hostname.toLowerCase(), effectiveRetryAt);
    return new GitHubRequestError(
      `GitHub 拒绝了自动请求（HTTP 403${detail ? `：${detail}` : ""}），请稍后重试或配置 GITHUB_TOKEN`,
      response.status,
      effectiveRetryAt,
      true,
    );
  }

  return new GitHubRequestError(
    `GitHub 请求失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）`,
    response.status,
    undefined,
    response.status >= 500,
  );
}

export function isRecoverableGitHubError(error: unknown) {
  return (
    (error instanceof GitHubRequestError && error.recoverable) ||
    (error instanceof Error &&
      /GitHub (?:API )?请求额度已用尽|GitHub 拒绝了自动请求|GitHub 请求暂时受限/.test(
        error.message,
      ))
  );
}

export function resetGitHubRequestStateForTests() {
  cooldowns.clear();
}
