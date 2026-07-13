import type { PermissionMode, PermissionPolicy } from "./types";

export function resolvePermissionDecision(
  mode: PermissionMode,
  policy: PermissionPolicy | undefined,
  category: keyof PermissionPolicy | undefined,
) {
  if (!category) return "allow" as const;
  if (mode === "full-access") return "allow" as const;
  if (mode === "read-only") return "deny" as const;
  return policy?.[category] ?? "confirm";
}
