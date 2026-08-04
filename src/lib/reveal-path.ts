import { errorMessage } from "./format";
import { showAppToast } from "./toast";

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localPathFromMarkdownHref(href?: string) {
  const value = href?.trim();
  if (!value || value.startsWith("#") || value.startsWith("//"))
    return undefined;
  if (/^https?:/i.test(value)) return undefined;
  if (/^file:/i.test(value) || WINDOWS_DRIVE_PATH.test(value)) return value;
  if (URI_SCHEME.test(value)) return undefined;
  return decodePath(value);
}

export async function revealLocalPath(
  targetPath: string,
  workspacePath: string,
) {
  if (typeof window === "undefined" || !window.kcode?.shell?.revealPath) {
    showAppToast("当前环境无法打开文件资源管理器", "error");
    return false;
  }
  try {
    await window.kcode.shell.revealPath(targetPath, workspacePath);
    return true;
  } catch (error) {
    showAppToast(`无法定位文件：${errorMessage(error)}`, "error");
    return false;
  }
}
