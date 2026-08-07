import path from "node:path";

export function resolveSshWorkspacePath(
  rootPath: string,
  requestedPath?: string,
  fallback = "",
) {
  const raw = requestedPath?.trim() || fallback;
  if (!raw) return "";
  const root = path.posix.resolve(rootPath);
  const resolved = path.posix.resolve(
    raw.startsWith("/") ? raw : path.posix.join(root, raw),
  );
  if (root !== "/" && resolved !== root && !resolved.startsWith(`${root}/`))
    throw new Error("远程路径必须位于当前 SSH 工作区内。");
  return resolved;
}

export function sshWorkspaceCommand(rootPath: string, command: string) {
  const quotedRoot = `'${rootPath.replaceAll("'", `'\\''`)}'`;
  return `cd -- ${quotedRoot} && (${command})`;
}
