import { existsSync } from "node:fs";
import path from "node:path";

export function gitExecutableCandidates(env: NodeJS.ProcessEnv = process.env) {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  const pathEntries = String(env.Path || env.PATH || "")
    .split(process.platform === "win32" ? ";" : path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.join(entry, executable));
  const knownWindowsPaths = [
    env.GIT_EXECUTABLE,
    env.ProgramFiles &&
      path.win32.join(env.ProgramFiles, "Git", "cmd", "git.exe"),
    env["ProgramFiles(x86)"] &&
      path.win32.join(env["ProgramFiles(x86)"]!, "Git", "cmd", "git.exe"),
    env.LOCALAPPDATA &&
      path.win32.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
    env.USERPROFILE &&
      path.win32.join(
        env.USERPROFILE,
        "scoop",
        "apps",
        "git",
        "current",
        "cmd",
        "git.exe",
      ),
    env.ChocolateyInstall &&
      path.win32.join(env.ChocolateyInstall, "bin", "git.exe"),
  ].filter((value): value is string => Boolean(value));
  return [...new Set([...pathEntries, ...knownWindowsPaths])];
}

export function resolveGitExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
) {
  return gitExecutableCandidates(env).find(exists) ?? "git";
}
