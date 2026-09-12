import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lockJson = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const expectedTag = process.argv[2] ?? (await execFileAsync("git", ["describe", "--tags", "--exact-match", "HEAD"]).then(({ stdout }) => stdout.trim()).catch(() => ""));
const expectedVersion = expectedTag.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error(`Invalid package version: ${packageJson.version}`);
if (lockJson.version !== packageJson.version || lockJson.packages?.[""].version !== packageJson.version)
  throw new Error(`package.json and package-lock.json versions differ (${packageJson.version})`);
if (expectedVersion && expectedVersion !== packageJson.version)
  throw new Error(`Tag ${expectedTag} does not match package version ${packageJson.version}`);

console.log(`Release version OK: ${packageJson.version}${expectedTag ? ` (${expectedTag})` : ""}`);