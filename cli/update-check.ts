import path from "node:path";
import os from "node:os";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

const PACKAGE_NAME = "@kk1181958464/kcode";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 2_000;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

interface UpdateCache {
  checkedAt: number;
  checkedVersion?: string;
  latestVersion: string;
  failed?: boolean;
}

export interface CliUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  installCommand: string;
  source: "cache" | "registry";
}

export interface CheckCliUpdateOptions {
  currentVersion: string;
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: boolean;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4]
          .split(".")
          .map((part) =>
            /^\d+$/.test(part) ? Number(part) : part.toLowerCase(),
          )
      : [],
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string")
      return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function defaultCachePath(): string {
  const stateDir = process.env.KCODE_HOME || path.join(os.homedir(), ".kcode");
  return path.join(stateDir, "cli-update-check.json");
}

async function readCache(cachePath: string): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(
      await readFile(cachePath, "utf8"),
    ) as Partial<UpdateCache>;
    if (
      typeof parsed.checkedAt !== "number" ||
      !Number.isFinite(parsed.checkedAt) ||
      typeof parsed.latestVersion !== "string" ||
      !parseVersion(parsed.latestVersion)
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      checkedVersion:
        typeof parsed.checkedVersion === "string" &&
        parseVersion(parsed.checkedVersion)
          ? parsed.checkedVersion
          : undefined,
      latestVersion: parsed.latestVersion,
      failed: parsed.failed === true,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  cachePath: string,
  cache: UpdateCache,
): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    await writeFile(cachePath, JSON.stringify(cache), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(cachePath, 0o600).catch(() => undefined);
  } catch {
    // Update checks are best-effort and must never prevent CLI startup.
  }
}

function updateInfo(
  currentVersion: string,
  latestVersion: string,
  source: CliUpdateInfo["source"],
): CliUpdateInfo | null {
  if (compareVersions(latestVersion, currentVersion) <= 0) return null;
  return {
    currentVersion,
    latestVersion,
    installCommand: `npm install -g ${PACKAGE_NAME}@latest`,
    source,
  };
}

export async function checkForCliUpdate(
  options: CheckCliUpdateOptions,
): Promise<CliUpdateInfo | null> {
  const currentVersion = options.currentVersion.trim();
  if (!parseVersion(currentVersion)) return null;
  const cachePath = options.cachePath ?? defaultCachePath();
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const cache = await readCache(cachePath);

  const cacheInterval = cache?.failed ? FAILURE_INTERVAL_MS : intervalMs;
  if (
    !options.force &&
    cache?.checkedVersion === currentVersion &&
    now - cache.checkedAt < cacheInterval
  ) {
    return updateInfo(currentVersion, cache.latestVersion, "cache");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
    const response = await (options.fetchImpl ?? fetch)(registryUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": `kcode-cli/${currentVersion}`,
      },
    });
    if (!response.ok)
      throw new Error(`npm registry returned ${response.status}`);
    const payload = (await response.json()) as { version?: unknown };
    const latestVersion =
      typeof payload.version === "string" ? payload.version.trim() : "";
    if (!parseVersion(latestVersion))
      throw new Error("invalid npm version response");
    await writeCache(cachePath, {
      checkedAt: now,
      checkedVersion: currentVersion,
      latestVersion,
    });
    return updateInfo(currentVersion, latestVersion, "registry");
  } catch {
    await writeCache(cachePath, {
      checkedAt: now,
      checkedVersion: currentVersion,
      latestVersion: cache?.latestVersion ?? currentVersion,
      failed: true,
    });
    return cache
      ? updateInfo(currentVersion, cache.latestVersion, "cache")
      : null;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
