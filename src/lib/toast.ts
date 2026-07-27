export type AppToastHandler = (
  message: string,
  tone?: "success" | "error",
) => void;
export type AppToast = {
  id: number;
  message: string;
  tone?: "success" | "error";
};

let handler: AppToastHandler | undefined;

export function registerAppToastHandler(next: AppToastHandler) {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

export function showAppToast(
  message: string,
  tone: "success" | "error" = "success",
) {
  handler?.(message, tone);
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export async function copyWithToast(text: string, successMessage = "复制成功") {
  const copied = await copyTextToClipboard(text);
  showAppToast(
    copied ? successMessage : "复制失败",
    copied ? "success" : "error",
  );
  return copied;
}
