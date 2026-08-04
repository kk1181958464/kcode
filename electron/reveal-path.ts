import path from "node:path";

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(value: string) {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new Error("只支持本地文件链接");
  const pathname = decodePath(url.pathname);
  if (process.platform === "win32") {
    if (url.hostname && url.hostname !== "localhost")
      return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
    return pathname.replace(/^\/(?=[a-z]:\/)/i, "").replaceAll("/", "\\");
  }
  return pathname;
}

export function resolveRevealPath(rawPath: string, workspacePath: string) {
  const value = rawPath.trim();
  if (!value) throw new Error("文件路径不能为空");
  const localPath = /^file:/i.test(value)
    ? fileUrlPath(value)
    : decodePath(value);
  if (URI_SCHEME.test(localPath) && !WINDOWS_DRIVE_PATH.test(localPath))
    throw new Error("只支持本地文件路径");
  const root = path.resolve(workspacePath);
  return path.resolve(
    path.isAbsolute(localPath) ? localPath : path.join(root, localPath),
  );
}
