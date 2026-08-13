import type { PermissionMode } from "../src/types";

export function resolveInitialPermissionMode(options: {
  interactive: boolean;
  yolo: boolean;
  saved?: PermissionMode;
}): PermissionMode {
  if (options.yolo) return "full-access";
  if (!options.interactive) return "read-only";
  return options.saved ?? "confirm";
}
