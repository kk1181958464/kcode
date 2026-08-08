import type { PermissionMode, PermissionPolicy } from "./types";

export type CommandPolicyAction = "allow" | "prompt" | "deny";

export type CommandPolicyRule = {
  action: CommandPolicyAction;
  match: string[];
  notMatch?: string[];
  reason?: string;
};

export type CommandPolicyResult = {
  action: CommandPolicyAction;
  matched?: CommandPolicyRule;
  tokens: string[][];
};

/** Tokenize shell-like command segments without executing or expanding them. */
export function tokenizeShellCommand(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const pushToken = () => {
    if (token) current.push(token);
    token = "";
  };
  const pushSegment = () => {
    pushToken();
    if (current.length) segments.push(current);
    current = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "`" && quote === '"' && index + 1 < command.length)
        token += command[++index];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      pushSegment();
      continue;
    }
    if (char === "&" || char === "|") {
      pushSegment();
      if (command[index + 1] === char) index += 1;
      continue;
    }
    token += char;
  }
  pushSegment();
  return segments;
}

function executableName(value: string) {
  return value
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

function prefixMatches(tokens: string[], prefix: string[]) {
  return prefix.every(
    (value, index) => tokens[index]?.toLowerCase() === value.toLowerCase(),
  );
}

export function evaluateCommandPolicy(
  command: string,
  rules: readonly CommandPolicyRule[],
): CommandPolicyResult {
  const tokens = tokenizeShellCommand(command);
  for (const rule of rules) {
    const matched = tokens.some(
      (segment) =>
        prefixMatches(segment, rule.match) &&
        !(rule.notMatch ?? []).some((notMatch) =>
          prefixMatches(segment, notMatch.split(/\s+/).filter(Boolean)),
        ),
    );
    if (matched) return { action: rule.action, matched: rule, tokens };
  }
  return { action: "prompt", tokens };
}

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
  for (const segment of tokenizeShellCommand(command)) {
    const tokens = segment.filter((token) => token !== "&");
    const executable = executableName(tokens[0] ?? "") ?? "";
    if (executable === "git") {
      let subcommand = "";
      for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "-C" || token === "-c" || token === "--git-dir") {
          index += 1;
          continue;
        }
        if (token.startsWith("-")) continue;
        subcommand = token.toLowerCase();
        break;
      }
      if (subcommand === "push" || subcommand === "commit")
        return "gitPublish";
      if (["fetch", "pull", "clone", "submodule"].includes(subcommand))
        return "network";
    }
    if (["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "ssh", "scp"].includes(executable))
      return "network";
    if (
      (executable === "npm" || executable === "pnpm" || executable === "yarn") &&
      ["install", "add", "view", "publish"].includes(
        (tokens[1] ?? "").toLowerCase(),
      )
    )
      return "network";
  }
  // Keep a conservative fallback for command syntaxes that are not tokenized
  // cleanly (for example nested PowerShell expressions).
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
