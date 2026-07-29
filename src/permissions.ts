import type { PermissionMode, PermissionPolicy } from "./types";

export function resolvePermissionDecision(
  mode: PermissionMode,
  policy: PermissionPolicy | undefined,
  category: keyof PermissionPolicy | undefined,
) {
  if (!category) return "allow" as const;
  if (mode === "read-only") return "deny" as const;
  return policy?.[category] ?? (mode === "full-access" ? "allow" : "confirm");
}

export function isPermissionPolicyCustomized(
  mode: PermissionMode,
  policy: PermissionPolicy,
) {
  if (mode === "read-only") return false;
  const defaultDecision = mode === "full-access" ? "allow" : "confirm";
  return Object.values(policy).some((value) => value !== defaultDecision);
}

export function permissionCategoryForCommand(
  command: string,
): keyof PermissionPolicy {
  if (/\bgit(?:\.exe)?\b[^\r\n;&|]*\b(?:push|commit)\b/i.test(command))
    return "gitPublish";
  if (
    /\b(curl|wget|invoke-webrequest|npm\s+(install|view)|git(?:\.exe)?\b[^\r\n;&|]*\b(fetch|pull|clone))\b/i.test(
      command,
    )
  )
    return "network";
  return "runCommands";
}
